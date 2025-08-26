FROM python:3.11-slim

RUN apt-get update && apt-get install -y gcc libffi-dev libssl-dev python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY script.py .
COPY templates/ ./templates/
COPY static/ ./static/

EXPOSE 5000

CMD ["python", "script.py"]