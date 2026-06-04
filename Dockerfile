# Official Playwright image — all browser deps pre-installed
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
# Explicitly install the browsers matched to the npm playwright version
RUN npx playwright install chromium --with-deps

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
