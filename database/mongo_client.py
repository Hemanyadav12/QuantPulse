from datetime import datetime, timezone
from pymongo import ASCENDING, DESCENDING, MongoClient

MONGO_URI = "mongodb://localhost:27017/"
DB_NAME = "quantpulse"


def get_database():
    """Returns a handle to the QuantPulse MongoDB database and ensures indexes exist."""
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    db = client[DB_NAME]

    db["market_predictions"].create_index([("symbol", ASCENDING), ("timestamp", DESCENDING)])
    db["news_sentiment"].create_index([("related_symbol", ASCENDING), ("ingested_at", DESCENDING)])
    db["system_metrics"].create_index([("timestamp", DESCENDING)])
    return db


def insert_market_predictions(db, records: list[dict]):
    if records:
        db["market_predictions"].insert_many(records)


def insert_news_sentiment(db, records: list[dict]):
    if records:
        db["news_sentiment"].insert_many(records)


def get_latest_symbol_sentiment(db, symbol: str) -> float:
    """Fetches average recent VADER score for a symbol (falls back to GENERAL news if none)."""
    pipeline = [
        {"$match": {"related_symbol": {"$in": [symbol, "GENERAL"]}}},
        {"$sort": {"ingested_at": -1}},
        {"$limit": 10},
        {"$group": {"_id": None, "avg_score": {"$avg": "$sentiment_score"}}},
    ]
    res = list(db["news_sentiment"].aggregate(pipeline))
    return round(float(res[0]["avg_score"]), 4) if res else 0.0


def log_batch_metric(db, stream_name: str, batch_id: int, record_count: int, duration_ms: float):
    db["system_metrics"].insert_one({
        "stream_name": stream_name,
        "batch_id": batch_id,
        "record_count": record_count,
        "duration_ms": round(duration_ms, 2),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })