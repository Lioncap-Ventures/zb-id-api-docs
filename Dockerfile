# Image for the ZB ID API reference (zbid-docs.lioncapventures.com).
#
# EVERY VALUE BAKED HERE IS PUBLIC. Nothing secret may ever be added: no ARG or
# ENV carrying a credential. The Try-it proxy holds no secret at all (a visitor
# drives register/login against STAGING ZB ID and the returned token is chained
# in their own browser); its runtime settings come from the Cloud Run service.
#
# Multi-stage on a pinned major line, standalone Next output, non-root runner.
FROM node:22-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Shows the interactive "Try it" panels; inlined into the client bundle at build
# time, so it has to be present here and not only at runtime.
ENV NEXT_PUBLIC_TRYIT_ENABLED=true
RUN corepack enable pnpm && pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root. The runner executes `node server.js` and nothing else, so the base
# image's npm, npx, corepack and yarn (and the libraries they vendor) go too.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
