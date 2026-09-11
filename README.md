# তাবিজ TopUp — Full Website Structure

## Files
- index.html — main user website (single-file frontend)
- admin/index.html — admin panel
- api/create-payment.js — Tabij Pay checkout creation
- api/verify-payment.js — Tabij Pay payment verification + wallet/order update
- package.json — Vercel/API dependency

## Vercel environment variables
- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- RUPANTOR_API_KEY

The payment API uses the gateway key only on the server. Do not place it inside index.html.

## Firebase
Use the existing tabijtopup Firebase project and the same Firebase config already present in index.html.

## Deploy
Deploy this folder to Vercel. Keep `index.html` at the project root and the API files under `/api`.

## Current user flow
Login -> Category -> Service -> Package -> Player ID -> Nickname Check -> Wallet Pay or Tabij Pay -> Payment verification -> Order created.

Automatic Free Fire delivery is not included unless a separate game-delivery API is integrated.
