# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**thelaby-cipher** - Puppeteer-based auto-upload tool for The Labyrinth (더라비린스)

- Site: https://www.thelabyrinth.co.kr
- Purpose: Automatically upload/update labyrinths and pages to the site
- Split from: anagram (the main labyrinth development framework)

## Commands

```bash
node upload.js <content-folder>   # Upload labyrinth to site
npm run upload                    # Upload example folder
```

## Architecture

### Module Structure

```
thelaby-cipher/
├── upload.js           # Main entry point - orchestrates upload process
├── src/
│   ├── login.js        # Puppeteer login/logout
│   ├── labyrinth.js    # Labyrinth CRUD (create, update, validate)
│   ├── page.js         # Page CRUD (create, update, delete, answers, connections)
│   └── image.js        # Image upload via SmartEditor2 popup
└── example/            # Example labyrinth content
    ├── labyrinth.json
    ├── account.json    # Credentials (gitignore)
    └── page/
        ├── *.html      # Page HTML content
        └── *.json      # Page metadata
```

### Data Flow

```
account.json + labyrinth.json + page/*.html + page/*.json
        ↓
   [Validation]
        ↓
  [Login to site]
        ↓
 [Create/Update labyrinth]
        ↓
   [Page upload]
        ↓
labyrinth.meta + page/*.meta (updated)
```

## Configuration Files

### account.json (required, gitignored)

Credentials are stored separately from labyrinth config.

```json
{
    "email": "user@email.com",
    "password": "password"
}
```

`email` 또는 `id` 필드를 사용합니다.

### labyrinth.json (required)

```json
{
    "title": "미궁명",
    "image": "./image/title.jpg",
    "description": "설명",
    "tags": ["puzzle", "short"],
    "start_page": "start",
    ...
}
```

Note: No email/password fields - these are in account.json.

### labyrinth.meta (auto-generated)

```json
{
    "id": "7199",
    "hash": "abc123...",
    "pageIds": ["75331", "75330"],
    "images": { "checksum": "https://uploaded-url.jpg" }
}
```

### page/*.html (content)

Direct HTML content that goes into the SmartEditor2.

```html
<p style="text-align: center; color: #ffffff;">
    Page content here
</p>
```

### page/*.json (metadata)

```json
{
    "title": "페이지 제목",
    "background_color": "#000000",
    "answers": [
        { "answer": "정답", "next": "page-b", "public": false }
    ],
    "is_ending": false
}
```

### page/*.meta (auto-generated)

```json
{ "id": "12345", "hash": "def456..." }
```

## Upload Process

1. Create new pages (with content, answers, images)
2. Update modified pages (content, answers, images)
3. Set parent connections (answer → next page links)

### Page State Detection

| HTML | JSON | Meta | pageIds | State | Action |
|------|------|------|---------|-------|--------|
| ✓ | ✓ | ✓ | ✓ | normal | Update if hash changed |
| ✓ | ✓ | ✗ | ✗ | new | Create |
| ✓ | ✗ | - | - | json_missing | Warn, skip |
| ✗ | ✓ | - | - | html_missing | Warn, skip |
| - | - | ✓ | ✓ | orphan | Delete from site |
| ✓ | ✓ | ✓ | ✗ | pageIds_missing | Delete & recreate |

**Key principle:** Both HTML and JSON must exist for a page to be uploaded.

## Key Implementation Details

### Hash-based Change Detection

- Config hash stored in `.meta` files
- Hash includes both HTML content and JSON metadata
- Only uploads when content hash differs
- Image changes detected via file checksum

### SmartEditor2 Integration

- Content set via `oEditors.getById['quest'].setIR(html)`
- Images uploaded via photo uploader popup
- Must call `UPDATE_CONTENTS_FIELD` before form submit

### Parent Connection System

- Set on child page, not parent
- Checkbox value format: `{parentPageId}-{answerIndex}`
- Must be set after answers exist on parent page

### Image Upload

- Local image paths in HTML are automatically uploaded
- Supports `src="..."` (img tags) and `url(...)` (CSS background-image)
- Checksum-based deduplication (skip if already uploaded)
- URLs replaced in HTML before setting content

## Dependencies

- **puppeteer**: Browser automation
- Node.js built-ins: crypto, fs, path

## Code Style

All comments and documentation in code must be written in English.
