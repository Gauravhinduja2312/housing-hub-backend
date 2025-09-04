# --- Stage 1: The Builder ---
# This stage installs dependencies and builds our application
FROM node:18-alpine AS builder

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker's layer caching
COPY package*.json ./

# Install all project dependencies
RUN npm install

# Copy the rest of your application's source code
COPY . .


# --- Stage 2: The Production Image ---
# This stage creates the final, lightweight image for production
FROM node:18-alpine

# Set the working directory
WORKDIR /app

# Copy only the necessary installed dependencies from the 'builder' stage
COPY --from=builder /app/node_modules ./node_modules

# Copy the application code from the 'builder' stage
COPY --from=builder /app .

# Expose the port that your server runs on
EXPOSE 3001

# The command to run your application when the container starts
CMD ["node", "server.js"]