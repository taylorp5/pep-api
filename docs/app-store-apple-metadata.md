# App Store (Apple) – Metadata Checklist

Apple rejected the app under **Guideline 2.3 - Performance - Accurate Metadata** because the listing mentioned a **Widget** that is not in the app.

## What to do

**Remove every reference to "Widget" from the app’s listing in App Store Connect.**

### 1. App Store Connect (appstoreconnect.apple.com)

- **App Information**
  - Subtitle (if it mentions Widget) → remove or reword.
- **Version / Prepare for Submission**
  - **Description** → Remove any sentence or bullet that mentions a widget.
  - **Keywords** → Remove "widget" if present.
  - **Release notes (What’s New)** → Remove any mention of widget.
- **Screenshots**
  - Replace or remove any screenshot whose caption or overlay text says "Widget" or implies a widget feature.
- **Promotional text** (if used)
  - Remove widget mentions.
- **App previews / videos** (if any)
  - Remove or re-edit if they show or mention a widget.

### 2. Reply to Apple (optional)

In **App Review** → your app’s rejection → **Reply to App Review** you can write something like:

> We have removed all references to the Widget feature from our app description, release notes, and screenshots. The current version of the app does not include a widget; we have updated our metadata to match the implemented features. Thank you.

Then resubmit the build (or the same build) after saving the updated metadata.

### 3. Going forward

- Do not mention **Widget** (or any unimplemented feature) in:
  - App description  
  - Release notes  
  - Screenshots and captions  
  - Keywords  
  - Promotional text or previews  

---

*This repo does not contain the live App Store description text; that is edited only in App Store Connect.*
