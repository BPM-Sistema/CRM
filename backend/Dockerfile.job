FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy all source code
COPY . .

# Run the sync job
CMD ["node", "jobs/sync-orders-count.js"]
