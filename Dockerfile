FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN pip install --no-cache-dir \
    "flask>=3.0.0" \
    "flask-sock>=0.7.0" \
    "requests>=2.32.0"

COPY app ./app
COPY run.py run.app pyproject.toml README.md ./

EXPOSE 8000

CMD ["python", "run.py"]