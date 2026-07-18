# Setup Instructions

## 1. Prerequisites

Install these on your computer:
- [Node.js 18+](https://nodejs.org/)
- [Firebase CLI](https://firebase.google.com/docs/cli)
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)

## 2. Clone Repository

```bash
git clone https://github.com/your-org/agri-lend-api.git
cd agri-lend-api
```

## 3. Install Dependencies

```bash
npm install
cd functions && npm install
```

## 4. Add Service Account Key

1. Get your `gee-service-account-key.json` from Google Cloud Console
2. Copy it to: `functions/gee-service-account-key.json`
3. DO NOT commit this file (it's in .gitignore)

## 5. Configure Firebase

```bash
firebase login
firebase use --add
# Select your Firebase project
```

## 6. Test Locally

```bash
firebase emulators:start --only functions
```

Visit: `http://localhost:5001/your-project-id/us-central1/agriLendAPI/api/v1/health`

## 7. Deploy to Production

```bash
firebase deploy --only functions
```

## Troubleshooting

See DEVELOPMENT.md for common issues.