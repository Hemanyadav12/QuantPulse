import os
import sys

# Ensure Windows uses the active virtual environment's Python and local Hadoop winutils
os.environ["PYSPARK_PYTHON"] = sys.executable
os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
os.environ["HADOOP_HOME"] = r"D:\Projects\QunatPulse\hadoop"
os.environ["PATH"] += os.pathsep + r"D:\Projects\QunatPulse\hadoop\bin"

import numpy as np
import pandas as pd
import yfinance as yf
from pyspark.ml import Pipeline
from pyspark.ml.classification import LogisticRegression
from pyspark.ml.evaluation import MulticlassClassificationEvaluator, RegressionEvaluator
from pyspark.ml.feature import StandardScaler, VectorAssembler
from pyspark.ml.regression import GBTRegressor, RandomForestRegressor
from pyspark.sql import SparkSession

TICKERS = ["AAPL", "TSLA", "NVDA", "BTC-USD", "ETH-USD"]
MODEL_DIR = "models"


def create_spark_session() -> SparkSession:
    spark = (
        SparkSession.builder.appName("QuantPulse-OfflineMLTrainer")
        .master("local[*]")
        .config("spark.driver.host", "127.0.0.1")
        .config("spark.driver.bindAddress", "127.0.0.1")
        .config("spark.sql.shuffle.partitions", "2")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("WARN")
    return spark


def build_historical_dataset() -> pd.DataFrame:
    """Downloads 60d hourly bars from yfinance and engineers streaming-compatible features."""
    print("Downloading 60-day hourly historical market data from Yahoo Finance...")
    frames = []
    rng = np.random.default_rng(42)

    for symbol in TICKERS:
        hist = yf.Ticker(symbol).history(period="60d", interval="1h")
        if hist.empty:
            continue

        df = hist[["Close", "Volume"]].copy().reset_index(drop=True)
        df["symbol"] = symbol
        df["avg_price"] = df["Close"].rolling(window=5).mean()
        df["price_volatility"] = df["Close"].rolling(window=5).std().fillna(0.0)
        df["pct_return"] = df["Close"].pct_change().fillna(0.0)
        df["volume_ratio"] = (df["Volume"] / df["Volume"].rolling(window=10).mean()).fillna(1.0)

        # Synthetic sentiment signal correlated with short-term momentum + market noise
        noise = rng.normal(0, 0.25, size=len(df))
        df["sentiment_score"] = np.clip(np.tanh(df["pct_return"] * 25.0) + noise, -1.0, 1.0)

        # Target 1: Next-hour percentage return (%)
        df["next_return"] = df["Close"].pct_change().shift(-1) * 100.0
        # Target 2: Binary price direction (1.0 = UP, 0.0 = DOWN)
        df["direction_label"] = (df["next_return"] > 0).astype(float)

        df = df.dropna().reset_index(drop=True)
        frames.append(
            df[["avg_price", "price_volatility", "pct_return", "volume_ratio", "sentiment_score", "next_return", "direction_label"]]
        )

    full_df = pd.concat(frames, ignore_index=True)
    print(f"Dataset ready: {len(full_df)} feature rows across {len(TICKERS)} assets.")
    return full_df


def train_and_evaluate():
    pdf = build_historical_dataset()
    spark = create_spark_session()
    sdf = spark.createDataFrame(pdf)

    feature_cols = ["avg_price", "price_volatility", "pct_return", "volume_ratio", "sentiment_score"]
    assembler = VectorAssembler(inputCols=feature_cols, outputCol="raw_features")
    scaler = StandardScaler(inputCol="raw_features", outputCol="features", withStd=True, withMean=True)

    train_df, test_df = sdf.randomSplit([0.8, 0.2], seed=42)
    print(f"Train rows: {train_df.count()} | Test rows: {test_df.count()}\n")

    # 1. Regression Models: GBTRegressor vs RandomForestRegressor
    reg_rmse_eval = RegressionEvaluator(labelCol="next_return", predictionCol="prediction", metricName="rmse")
    reg_r2_eval = RegressionEvaluator(labelCol="next_return", predictionCol="prediction", metricName="r2")

    gbt = GBTRegressor(featuresCol="features", labelCol="next_return", maxIter=40, maxDepth=4, seed=42)
    gbt_pipeline = Pipeline(stages=[assembler, scaler, gbt])
    gbt_model = gbt_pipeline.fit(train_df)
    gbt_preds = gbt_model.transform(test_df)

    rf = RandomForestRegressor(featuresCol="features", labelCol="next_return", numTrees=50, maxDepth=5, seed=42)
    rf_pipeline = Pipeline(stages=[assembler, scaler, rf])
    rf_model = rf_pipeline.fit(train_df)
    rf_preds = rf_model.transform(test_df)

    # 2. Classification Model: Price Direction (UP vs DOWN)
    lr = LogisticRegression(featuresCol="features", labelCol="direction_label", maxIter=50)
    clf_pipeline = Pipeline(stages=[assembler, scaler, lr])
    clf_model = clf_pipeline.fit(train_df)
    clf_preds = clf_model.transform(test_df)

    acc_eval = MulticlassClassificationEvaluator(labelCol="direction_label", predictionCol="prediction", metricName="accuracy")
    f1_eval = MulticlassClassificationEvaluator(labelCol="direction_label", predictionCol="prediction", metricName="f1")

    print("=" * 62)
    print("QUANTPULSE OFFLINE ML EVALUATION REPORT (TEST SPLIT)")
    print("=" * 62)
    print(f"GBT Regressor          -> RMSE: {reg_rmse_eval.evaluate(gbt_preds):.4f}% | R2: {reg_r2_eval.evaluate(gbt_preds):.4f}")
    print(f"Random Forest Reg.     -> RMSE: {reg_rmse_eval.evaluate(rf_preds):.4f}% | R2: {reg_r2_eval.evaluate(rf_preds):.4f}")
    print(f"Direction Classifier   -> Accuracy: {acc_eval.evaluate(clf_preds)*100:.2f}% | F1-Score: {f1_eval.evaluate(clf_preds):.4f}")
    print("=" * 62)

    # Save trained pipelines for real-time streaming inference
    gbt_path = os.path.join(MODEL_DIR, "gbt_return_model")
    clf_path = os.path.join(MODEL_DIR, "direction_clf_model")
    gbt_model.write().overwrite().save(gbt_path)
    clf_model.write().overwrite().save(clf_path)
    print(f"\nSaved trained models to '{gbt_path}' and '{clf_path}'.")

    spark.stop()


if __name__ == "__main__":
    train_and_evaluate()