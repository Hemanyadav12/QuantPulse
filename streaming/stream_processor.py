import os
import sys
import time
from datetime import datetime, timezone

os.environ["PYSPARK_PYTHON"] = sys.executable
os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
os.environ["HADOOP_HOME"] = r"D:\Projects\QunatPulse\hadoop"
os.environ["PATH"] += os.pathsep + r"D:\Projects\QunatPulse\hadoop\bin"

from pyspark.ml import PipelineModel
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import DoubleType, LongType, StringType, StructField, StructType

from database.mongo_client import (
    get_database,
    get_latest_symbol_sentiment,
    insert_market_predictions,
    insert_news_sentiment,
    log_batch_metric,
)
from streaming.nlp_pipeline import apply_nlp_and_sentiment, score_text_vader

KAFKA_BOOTSTRAP_SERVERS = "localhost:9092"
SPARK_KAFKA_PACKAGE = "org.apache.spark:spark-sql-kafka-0-10_2.13:4.3.0"

market_schema = StructType([
    StructField("symbol", StringType(), True),
    StructField("price", DoubleType(), True),
    StructField("volume", LongType(), True),
    StructField("timestamp", StringType(), True),
])

news_schema = StructType([
    StructField("source", StringType(), True),
    StructField("title", StringType(), True),
    StructField("description", StringType(), True),
    StructField("published_at", StringType(), True),
    StructField("ingested_at", StringType(), True),
])

_last_avg_price: dict[str, float] = {}


def create_spark_session() -> SparkSession:
    spark = (
        SparkSession.builder.appName("QuantPulse-StreamProcessor")
        .master("local[*]")
        .config("spark.driver.host", "127.0.0.1")
        .config("spark.driver.bindAddress", "127.0.0.1")
        .config("spark.jars.packages", SPARK_KAFKA_PACKAGE)
        .config("spark.sql.shuffle.partitions", "2")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("WARN")
    return spark


def start_streaming():
    spark = create_spark_session()
    db = get_database()
    print("Connected to MongoDB ('quantpulse'). Loading trained ML models...")

    gbt_model = PipelineModel.load("models/gbt_return_model")
    clf_model = PipelineModel.load("models/direction_clf_model")
    print("Loaded 'gbt_return_model' and 'direction_clf_model'. Listening to Kafka topics...")

    def process_market_batch(batch_df: DataFrame, batch_id: int):
        if batch_df.rdd.isEmpty():
            return
        t0 = time.perf_counter()

        agg_rows = (
            batch_df.groupBy("symbol")
            .agg(
                F.count("price").alias("tick_count"),
                F.round(F.avg("price"), 4).alias("avg_price"),
                F.round(F.coalesce(F.stddev("price"), F.lit(0.0)), 4).alias("price_volatility"),
                F.max("volume").alias("latest_volume"),
                F.max("timestamp").alias("latest_timestamp"),
            )
            .collect()
        )

        feature_rows = []
        for r in agg_rows:
            sym = r["symbol"]
            avg_p = float(r["avg_price"])
            prev_p = _last_avg_price.get(sym, avg_p)
            pct_ret = ((avg_p - prev_p) / prev_p) if prev_p > 0 else 0.0
            _last_avg_price[sym] = avg_p

            sent_score = get_latest_symbol_sentiment(db, sym)
            feature_rows.append({
                "symbol": sym,
                "tick_count": int(r["tick_count"]),
                "avg_price": avg_p,
                "price_volatility": float(r["price_volatility"]),
                "pct_return": float(pct_ret),
                "volume_ratio": 1.0,
                "sentiment_score": sent_score,
                "latest_volume": int(r["latest_volume"]),
                "latest_timestamp": r["latest_timestamp"],
            })

        feat_df = spark.createDataFrame(feature_rows)

        ret_preds = (
            gbt_model.transform(feat_df)
            .drop("raw_features", "features")
            .withColumnRenamed("prediction", "predicted_return_pct")
        )
        full_preds = clf_model.transform(ret_preds).withColumnRenamed("prediction", "dir_pred")

        out_rows = full_preds.select(
            "symbol",
            "tick_count",
            "avg_price",
            "price_volatility",
            "sentiment_score",
            "predicted_return_pct",
            "probability",
            "latest_volume",
            "latest_timestamp",
        ).collect()

        mongo_docs = []
        print(f"\n=== [LIVE ML MARKET PREDICTIONS - BATCH #{batch_id}] ===")
        print(f"{'SYMBOL':<9} | {'PRICE':<11} | {'VOLATILITY':<10} | {'SENTIMENT':<9} | {'PRED RET %':<10} | DIRECTION")
        print("-" * 74)
        for row in out_rows:
            pred_ret = round(float(row["predicted_return_pct"]), 4)
            # Align directional signal with predicted return + sentiment momentum so signals never contradict
            combined_signal = pred_ret + (float(row["sentiment_score"]) * 0.15)
            direction = "UP" if combined_signal > 0 else "DOWN"
            up_prob = round(float(row["probability"][1]) * 100, 1)

            print(
                f"{row['symbol']:<9} | {row['avg_price']:<11} | {row['price_volatility']:<10} | "
                f"{row['sentiment_score']:<9} | {pred_ret:<10} | {direction} ({up_prob}%)"
            )
            mongo_docs.append({
                "batch_id": batch_id,
                "symbol": row["symbol"],
                "tick_count": int(row["tick_count"]),
                "avg_price": float(row["avg_price"]),
                "price_volatility": float(row["price_volatility"]),
                "sentiment_score": float(row["sentiment_score"]),
                "predicted_return_pct": pred_ret,
                "predicted_direction": direction,
                "up_probability_pct": up_prob,
                "latest_volume": int(row["latest_volume"]),
                "timestamp": row["latest_timestamp"] or datetime.now(timezone.utc).isoformat(),
            })

        insert_market_predictions(db, mongo_docs)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        log_batch_metric(db, "market-ticks", batch_id, len(mongo_docs), elapsed_ms)

    def process_news_batch(batch_df: DataFrame, batch_id: int):
        if batch_df.rdd.isEmpty():
            return
        t0 = time.perf_counter()

        enriched_df = apply_nlp_and_sentiment(batch_df)
        rows = enriched_df.select(
            "related_symbol", "source", "title", "full_text", "published_at", "ingested_at"
        ).collect()

        mongo_docs = []
        print(f"\n=== [NEWS & NLP SENTIMENT SAVED TO MONGODB - BATCH #{batch_id}] ===")
        for row in rows:
            score, label = score_text_vader(row["full_text"])
            mongo_docs.append({
                "batch_id": batch_id,
                "related_symbol": row["related_symbol"],
                "source": row["source"],
                "title": row["title"],
                "sentiment_label": label,
                "sentiment_score": score,
                "published_at": row["published_at"],
                "ingested_at": row["ingested_at"] or datetime.now(timezone.utc).isoformat(),
            })

        insert_news_sentiment(db, mongo_docs)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        log_batch_metric(db, "social-sentiment-stream", batch_id, len(mongo_docs), elapsed_ms)
        print(f"Inserted {len(mongo_docs)} scored headlines into MongoDB ('news_sentiment') in {elapsed_ms:.1f} ms.")

    raw_market_df = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", KAFKA_BOOTSTRAP_SERVERS)
        .option("subscribe", "market-ticks")
        .option("startingOffsets", "latest")
        .load()
    )

    parsed_market_df = (
        raw_market_df.selectExpr("CAST(value AS STRING) as json_str")
        .select(F.from_json(F.col("json_str"), market_schema).alias("data"))
        .select("data.*")
        .filter(F.col("symbol").isNotNull())
    )

    raw_news_df = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", KAFKA_BOOTSTRAP_SERVERS)
        .option("subscribe", "social-sentiment-stream")
        .option("startingOffsets", "latest")
        .load()
    )

    parsed_news_df = (
        raw_news_df.selectExpr("CAST(value AS STRING) as json_str")
        .select(F.from_json(F.col("json_str"), news_schema).alias("data"))
        .select("data.*")
        .filter(F.col("title").isNotNull())
    )

    parsed_market_df.writeStream.foreachBatch(process_market_batch).outputMode("update").option(
        "checkpointLocation", "checkpoints/market"
    ).trigger(processingTime="15 seconds").start()

    parsed_news_df.writeStream.foreachBatch(process_news_batch).outputMode("update").option(
        "checkpointLocation", "checkpoints/news"
    ).trigger(processingTime="15 seconds").start()

    spark.streams.awaitAnyTermination()


if __name__ == "__main__":
    start_streaming()