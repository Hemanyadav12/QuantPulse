import json
import time
from datetime import datetime, timezone
import yfinance as yf
from kafka import KafkaProducer

# Connect to your KRaft Kafka broker
producer = KafkaProducer(
    bootstrap_servers=["localhost:9092"],
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    key_serializer=lambda k: k.encode("utf-8") if k else None,
)

TOPIC_NAME = "market-ticks"
TICKERS = ["AAPL", "TSLA", "NVDA", "BTC-USD", "ETH-USD"]


def stream_market_ticks():
    print(f"Starting Market Tick Producer -> Topic: '{TOPIC_NAME}'")
    try:
        while True:
            for symbol in TICKERS:
                try:
                    ticker = yf.Ticker(symbol)
                    info = ticker.fast_info

                    price = info.get("lastPrice")
                    volume = info.get("lastVolume")

                    if price is not None:
                        payload = {
                            "symbol": symbol,
                            "price": round(float(price), 4),
                            "volume": int(volume) if volume else 0,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        }

                        # Key-partition by ticker symbol so each asset's events stay ordered
                        producer.send(TOPIC_NAME, key=symbol, value=payload)
                        print(f"[SENT] {symbol}: ${payload['price']} | Vol: {payload['volume']}")

                except Exception as e:
                    print(f"[WARN] Failed fetching {symbol}: {e}")

            producer.flush()
            time.sleep(5)  # Fetch every 5 seconds

    except KeyboardInterrupt:
        print("\nStopping Market Tick Producer...")
    finally:
        producer.close()


if __name__ == "__main__":
    stream_market_ticks()