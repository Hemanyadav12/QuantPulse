import json
import os
import time
from datetime import datetime, timezone
import requests
from dotenv import load_dotenv
from kafka import KafkaProducer

load_dotenv()
NEWS_API_KEY = os.getenv("NEWS_API_KEY")

producer = KafkaProducer(
    bootstrap_servers=["localhost:9092"],
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    key_serializer=lambda k: k.encode("utf-8") if k else None,
)

TOPIC_NAME = "social-sentiment-stream"
QUERY = "Apple OR Tesla OR Nvidia OR Bitcoin OR stock market"
NEWS_URL = (
    f"https://newsapi.org/v2/everything?"
    f"q={QUERY}&language=en&sortBy=publishedAt&pageSize=10&apiKey={NEWS_API_KEY}"
)


def stream_financial_news():
    if not NEWS_API_KEY:
        raise ValueError("NEWS_API_KEY not found! Add it to your .env file first.")

    seen_urls = set()
    print(f"Starting Financial News Producer -> Topic: '{TOPIC_NAME}'")

    try:
        while True:
            response = requests.get(NEWS_URL, timeout=10)
            data = response.json()

            if data.get("status") != "ok":
                print(f"[ERROR] NewsAPI response: {data.get('message')}")
            else:
                articles = data.get("articles", [])
                new_count = 0

                for article in articles:
                    url = article.get("url")
                    title = article.get("title")

                    if url and title and url not in seen_urls and title != "[Removed]":
                        seen_urls.add(url)
                        source_name = article.get("source", {}).get("name", "Unknown")

                        payload = {
                            "source": source_name,
                            "title": title,
                            "description": article.get("description") or "",
                            "published_at": article.get("publishedAt"),
                            "ingested_at": datetime.now(timezone.utc).isoformat(),
                        }

                        producer.send(TOPIC_NAME, key=source_name, value=payload)
                        new_count += 1
                        print(f"[SENT NEWS] ({source_name}) {title[:75]}...")

                if new_count == 0:
                    print("[INFO] No new headlines since last poll.")

            producer.flush()
            time.sleep(60)  # Poll every 60 seconds to stay well within free API limits

    except KeyboardInterrupt:
        print("\nStopping Financial News Producer...")
    finally:
        producer.close()


if __name__ == "__main__":
    stream_financial_news()