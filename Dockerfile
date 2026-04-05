FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application files
COPY server.js .
COPY poller.js .
COPY dashboard.html .
COPY assets/ ./assets/

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 3000

# Start the webhook server
CMD ["node", "server.js"]
