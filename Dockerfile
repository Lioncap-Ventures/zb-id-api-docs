# Use an official Node runtime as the base image
FROM node:22.15.0 as build

# Set the working directory in the container to /app
WORKDIR /app

ENV NEXT_PUBLIC_BRAND_NAME="ZB ID"
ENV NEXT_PUBLIC_BRAND_URL=zbid-docs.lioncapventures.com
ENV NEXT_PUBLIC_BRAND_DESCRIPTION="Unified identity and authentication service for ZB Financial Holdings"
ENV NEXT_PUBLIC_CONTACT_EMAIL=tech@lioncapventures.com
ENV NEXT_PUBLIC_SUPPORT_EMAIL=tech@lioncapventures.com
# Copy package.json to the working directory
COPY package*.json pnpm-lock.yaml .npmrc ./

# Install pnpm and the application dependencies
RUN npm install -g pnpm@9 && pnpm install

# Copy the rest of the application code to the working directory
COPY . .

ARG NEXT_PUBLIC_API_BASE
ARG NEXT_PUBLIC_DOCS_BASE

# Build the application with API URLs injected at build time
RUN NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_BASE} NEXT_PUBLIC_API_DOCS_URL=${NEXT_PUBLIC_DOCS_BASE} pnpm run build

# Make port 3000 available to the outside world
EXPOSE 3000

# Run the application
CMD ["pnpm", "run", "start"]
