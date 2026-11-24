# QuantPulse — Real-Time Quantitative Analytics & Streaming Trading Terminal

QuantPulse is an end-to-end Big Data and real-time stream processing platform that ingests live equity and cryptocurrency market ticks alongside financial news, performs distributed feature engineering and NLP sentiment scoring in PySpark, predicts forward returns using Spark MLlib, and renders an institutional 3-zone trading terminal.

---

## System Architecture

```text
Live Market & News Producers (producers/)
        │
        ▼
Apache Kafka (KRaft Mode — docker-compose.yml)
        │
        ▼
PySpark 4.3 Structured Streaming (streaming/)
  ├── Rolling Window Volatility & Momentum Features
  ├── VADER NLP Headline Sentiment Scoring
  └── Spark MLlib Inference (GBTRegressor & LogisticRegression)
        │
        ▼
MongoDB (quantpulse database) & Hadoop Storage (hadoop/)
        │
        ▼
FastAPI Telemetry & Forecast API (api/main.py)
        │
        ▼
Institutional 3-Zone Trading Terminal (frontend/)
Key Features
Real-Time Data Ingestion (producers/): Streams live price ticks and financial news headlines for equities (AAPL, TSLA, NVDA) and cryptocurrencies (BTC-USD, ETH-USD) into Apache Kafka topics.

Distributed Stream Processing (streaming/): Uses Apache Spark Structured Streaming to compute rolling window metrics, score news sentiment with VADER NLP, and run real-time ML inference.

Machine Learning Pipeline (ml/, models/): Trains and serves GBTRegressor (return magnitude) and LogisticRegression (directional signal & confidence probability) models via Spark MLlib.

Low-Latency REST API (api/main.py): Exposes /api/market, /api/news, and /api/history endpoints backed by MongoDB (database/).

3-Zone Unified Price Trajectory & Forecast UI (frontend/):

Zone 1 (1M Historical Trend): 22-day calibrated historical close trajectory.

Zone 2 (Intraday & Live Stream): 8–10 hour 15-minute intraday baseline stitched seamlessly into live streaming quotes.

Zone 3 (48-Hour AI Forecast): 8-step (+6h to +48h (2D)) forward projection with a dynamic ±1σ confidence cone and interactive XY zoom/pan.

Repository Structure
Plaintext


QuantPulse/
├── api/                 # FastAPI backend server & REST endpoints
├── database/            # MongoDB connection & persistence helpers
├── frontend/            # Institutional trading dashboard (HTML, CSS, Vanilla JS + Chart.js)
├── hadoop/              # Hadoop / HDFS integration configurations
├── ml/                  # Spark MLlib feature engineering & model training scripts
├── models/              # Serialized Spark MLlib model artifacts
├── producers/           # Kafka market tick & financial news producers
├── streaming/           # PySpark Structured Streaming consumer & inference engine
├── docker-compose.yml   # Kafka (KRaft) & MongoDB container orchestration
└── requirements.txt     # Python dependencies
Quick Start
1. Start Infrastructure Services
Bash


docker-compose up -d
2. Install Python Dependencies
Bash


python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
3. Train ML Models (First-Time Setup)
Bash


python ml/train_models.py
4. Launch Streaming Pipeline, Producers & Web Terminal
Open separate terminals with .venv activated:

Bash


# Terminal 1: Start PySpark Structured Streaming processor
spark-submit --packages org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.0 streaming/stream_processor.py

# Terminal 2: Start Kafka market & news producers
python producers/market_producer.py
python producers/news_producer.py

# Terminal 3: Start FastAPI server & frontend UI
uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
Open http://localhost:8000 in your browser to view the terminal.
