FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# The bridge must be reachable from gramunnayan.com and from the Next.js
# gateway. Set the bridge's real STORAGE_GATEWAY_URL / R2_* / INTEGRATION_API_KEY
# secrets in the hosting platform environment, not in this image.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
