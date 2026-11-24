from pyspark.ml import Pipeline
from pyspark.ml.feature import HashingTF, IDF, StopWordsRemover, Tokenizer
from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

_analyzer = SentimentIntensityAnalyzer()


def score_text_vader(text: str) -> tuple[float, str]:
    """Returns (compound_score, sentiment_label) using VADER."""
    if not text or not text.strip():
        return 0.0, "NEUTRAL"
    score = round(float(_analyzer.polarity_scores(text)["compound"]), 4)
    if score >= 0.05:
        label = "POSITIVE"
    elif score <= -0.05:
        label = "NEGATIVE"
    else:
        label = "NEUTRAL"
    return score, label


def apply_nlp_and_sentiment(news_df: DataFrame) -> DataFrame:
    """
    Applies native Spark SQL ticker tagging + PySpark MLlib TF-IDF pipeline
    (Tokenizer -> StopWordsRemover -> HashingTF -> IDF) without Python UDF pickling.
    """
    cleaned_df = news_df.withColumn(
        "full_text",
        F.trim(F.concat_ws(" ", F.coalesce(F.col("title"), F.lit("")), F.coalesce(F.col("description"), F.lit("")))),
    ).withColumn(
        "clean_text",
        F.lower(F.regexp_replace(F.col("full_text"), r"[^a-zA-Z0-9\s]", " ")),
    )

    # Native Spark SQL ticker tagging (zero Python UDF serialization)
    lower_text = F.lower(F.col("full_text"))
    tagged_df = cleaned_df.withColumn(
        "related_symbol",
        F.when(lower_text.contains("apple") | lower_text.contains("aapl"), "AAPL")
        .when(lower_text.contains("tesla") | lower_text.contains("tsla"), "TSLA")
        .when(lower_text.contains("nvidia") | lower_text.contains("nvda"), "NVDA")
        .when(lower_text.contains("bitcoin") | lower_text.contains("btc"), "BTC-USD")
        .when(lower_text.contains("ethereum") | lower_text.contains("eth"), "ETH-USD")
        .otherwise("GENERAL"),
    )

    if tagged_df.rdd.isEmpty():
        return tagged_df

    # PySpark MLlib Distributed NLP Pipeline (Tokenizer -> StopWordsRemover -> HashingTF -> IDF)
    tokenizer = Tokenizer(inputCol="clean_text", outputCol="tokens")
    remover = StopWordsRemover(inputCol="tokens", outputCol="filtered_tokens")
    hashing_tf = HashingTF(inputCol="filtered_tokens", outputCol="raw_features", numFeatures=256)
    idf = IDF(inputCol="raw_features", outputCol="tfidf_features")

    nlp_pipeline = Pipeline(stages=[tokenizer, remover, hashing_tf, idf])
    nlp_model = nlp_pipeline.fit(tagged_df)
    transformed_df = nlp_model.transform(tagged_df)

    return transformed_df.select(
        "source",
        "related_symbol",
        "title",
        "full_text",
        "published_at",
        "ingested_at",
        "tfidf_features",
    )