# Setup Instructions

## API Key Configuration

1. **Copy the example configuration file:**
   ```bash
   cp env.example.js env.js
   ```

2. **Add your API keys to `env.js`:**
   - Get Deepgram API key from: https://console.deepgram.com/
   - Get OpenAI API key from: https://platform.openai.com/api-keys
   - Configure RAG base URL if using a custom backend

3. **IMPORTANT: Never commit `env.js`**
   - The file is already in `.gitignore`
   - Keep your API keys secure and private

## Resolving Git Push Error

If you already committed `env.js` with API keys, follow these steps:

### Option 1: Remove from latest commit (if not pushed yet)
```bash
git rm --cached env.js
git commit --amend -m "Remove env.js with API keys"
```

### Option 2: Remove from git history (if already pushed)
```bash
# Remove env.js from git tracking
git rm --cached env.js

# Commit the removal
git commit -m "Remove env.js from version control"

# Remove from history (WARNING: This rewrites history!)
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch env.js' \
  --prune-empty --tag-name-filter cat -- --all

# Force push (if working alone, or coordinate with team)
git push origin --force --all
```

### Option 3: Revoke and rotate API keys (RECOMMENDED)
1. **Revoke exposed keys immediately:**
   - OpenAI: https://platform.openai.com/api-keys
   - Deepgram: https://console.deepgram.com/

2. **Generate new API keys**

3. **Update your local `env.js` with new keys**

4. **Remove env.js from git:**
   ```bash
   git rm --cached env.js
   git commit -m "Remove env.js from tracking"
   git push
   ```

## After fixing

Once you've resolved the issue:
1. Reload the extension in `chrome://extensions/`
2. Test with your new API keys
