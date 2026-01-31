FROM node:20-slim

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/thepit.db

# Run
CMD ["node", "src/index.js"]
