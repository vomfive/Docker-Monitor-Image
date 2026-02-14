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

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/ping')" || exit 1

CMD ["gunicorn", "-w", "1", "--threads", "16", "-b", "0.0.0.0:5000", "--timeout", "120", "script:app"]
