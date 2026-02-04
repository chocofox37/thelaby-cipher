# thelaby-cipher

[더라비린스](https://www.thelabyrinth.co.kr)에 미궁을 자동으로 업로드하는 Puppeteer 기반 도구

## 설치

```bash
npm install
```

## 사용법

```bash
node upload.js [옵션] <콘텐츠-폴더>
```

### 옵션

| 옵션 | 설명 |
|------|------|
| `--show-browser` | 브라우저 창을 표시합니다 (디버깅용) |
| `--verbose` | 상세 로그를 출력합니다 |
| `--quiet`, `-q` | 에러만 출력합니다 |
| `--help`, `-h` | 도움말을 표시합니다 |

### 예시

```bash
# example 폴더의 미궁 업로드
node upload.js ./example

# 브라우저 창을 보면서 업로드 (디버깅)
node upload.js --show-browser ./example

# 상세 로그 출력
node upload.js --verbose ./example

# npm script 사용
npm run upload
```

### 서브모듈로 사용

미궁 프로젝트에 서브모듈로 추가:

```bash
git submodule add <repository-url> lib/thelaby-cipher
cd lib/thelaby-cipher && npm install
```

미궁 프로젝트 구조:
```
my-labyrinth/
├── lib/
│   └── thelaby-cipher/   ← 서브모듈
├── labyrinth.json
├── account.json
├── image/
└── page/
```

미궁 프로젝트 `package.json`:
```json
{
  "scripts": {
    "upload": "node lib/thelaby-cipher/upload.js ."
  }
}
```

## 콘텐츠 폴더 구조

필수 파일은 `labyrinth.json`과 `account.json`뿐이며, 나머지는 자유롭게 구성할 수 있습니다.

```
my-labyrinth/
├── labyrinth.json      # 미궁 설정 (필수)
├── account.json        # 계정 정보 (필수, gitignore 권장)
├── labyrinth.meta      # 업로드 메타 (자동 생성)
├── image/              # 이미지 폴더 (경로/이름 자유)
│   └── ...
└── page/               # 페이지 폴더 (경로/이름 자유)
    ├── {name}.html     # 페이지 HTML 콘텐츠
    ├── {name}.json     # 페이지 메타데이터
    └── {name}.meta     # 업로드 메타 (자동 생성)
```

## 설정 파일

### account.json

계정 정보를 별도 파일로 관리합니다. **반드시 `.gitignore`에 추가하세요.**

```json
{
    "email": "your-email@example.com",
    "password": "your-password"
}
```

`email` 또는 `id` 필드를 사용합니다.

### labyrinth.json

미궁 설정 파일입니다.

```json
{
    "title": "미궁 제목",
    "image": "./image/title.jpg",
    "description": ["첫 번째 줄", "두 번째 줄"],
    "tags": ["puzzle", "short"],
    "start_page": "시작-페이지-경로",
    "allow_rating": true,
    "show_difficulty": true,
    "clear_visibility": "full"
}
```

**필드 설명:**

| 필드 | 타입 | 설명 |
|------|------|------|
| `title` | string | 미궁 제목 (필수) |
| `image` | string | 타이틀 이미지 경로 (380x100) |
| `description` | string \| string[] | 미궁 설명 (최대 500자, 배열 시 줄바꿈으로 합침) |
| `tags` | string[] | 태그 (최대 5개) |
| `start_page` | string | 시작 페이지 경로 (labyrinth.json 기준, 확장자 제외) |
| `allow_rating` | boolean | 별점 허용 |
| `rating_threshold` | number | 별점 기준 (0=클리어 후, N=N페이지 후) |
| `show_difficulty` | boolean | 난이도 표시 |
| `show_page_count` | boolean | 전체 페이지 수 공개 |
| `show_ending_count` | boolean | 엔딩 수 공개 |
| `show_badend_count` | boolean | 배드엔딩 수 공개 |
| `clear_visibility` | string | 클리어 공개 (hidden/count/list/full) |
| `show_answer_rate` | boolean | 정답률 공개 |
| `block_right_click` | boolean | 우클릭 차단 |
| `login_required` | boolean | 로그인 필수 |

**지원 태그:**
- 영문: `problem`, `story`, `expert`, `no-search`, `search`, `specific-person`, `event`, `parody`, `movie`, `tv`, `comic`, `singer`, `actor`, `nonsense`, `cute`, `game`, `long`, `short`, `horror`, `escape`, `puzzle`, `mobile-ok`, `no-mobile`, `streaming-ok`
- 한글: `문제`, `스토리`, `전문지식`, `검색불필요`, `검색필요`, `특정인물`, `이벤트`, `패러디`, `영화`, `TV프로그램`, `만화`, `가수`, `배우`, `넌센스`, `귀염뽀짝`, `게임`, `장편미궁`, `단편미궁`, `공포`, `방탈출`, `퍼즐`, `모바일가능`, `모바일불가능`, `방송송출허용`

### page.html

페이지 HTML 콘텐츠입니다. 더라비린스 에디터에 직접 들어가는 내용입니다.

```html
<p style="text-align: center; color: #ffffff;">
    <span style="font-size: 24px;">페이지 내용</span>
</p>
```

### page.json

페이지 메타데이터입니다. **HTML과 JSON 파일이 모두 있어야 업로드됩니다.**

```json
{
    "title": "페이지 제목",
    "background_color": "#000000",
    "answers": [
        {
            "answer": "정답",
            "next": "다음-페이지-경로",
            "public": false,
            "explanation": "정답 설명"
        }
    ],
    "is_ending": false,
    "hint": "힌트 텍스트"
}
```

**필드 설명:**

| 필드 | 타입 | 설명 |
|------|------|------|
| `title` | string | 페이지 제목 (필수) |
| `background_color` | string | 배경색 (#RRGGBB) |
| `answers` | array | 정답 목록 |
| `is_ending` | boolean | 엔딩 페이지 여부 |
| `hint` | string | 힌트 |

**정답 객체:**

| 필드 | 타입 | 설명 |
|------|------|------|
| `answer` | string | 정답 텍스트 (필수) |
| `next` | string | 연결 페이지 경로 (labyrinth.json 기준, 확장자 제외) |
| `public` | boolean | 정답 공개 여부 |
| `explanation` | string | 정답 설명 |

## 업로드 프로세스

1. **로그인** - account.json의 계정으로 로그인
2. **미궁 생성/업데이트** - labyrinth.json 기반
3. **미사용 페이지 삭제** - 로컬에서 삭제된 페이지 제거
4. **페이지 생성/업데이트** - 신규 및 수정된 페이지 처리
5. **페이지 연결** - 정답 → 다음 페이지 연결 설정

## 페이지 상태 감지

| HTML | JSON | META | 상태 | 처리 |
|------|------|------|------|------|
| O | O | O | normal | 해시 변경 시 업데이트 |
| O | O | X | new | 신규 생성 |
| O | X | - | json_missing | 경고 + 스킵 |
| X | O | - | html_missing | 경고 + 스킵 |
| X | X | O | orphan | 삭제 |

## 이미지 업로드

HTML 내 로컬 이미지 경로는 자동으로 업로드되고 URL로 교체됩니다.

지원 패턴:
- `src="./image/sample.jpg"` (img 태그)
- `url(./image/bg.jpg)` (CSS background-image 등)

```html
<!-- 업로드 전 -->
<img src="./image/sample.jpg">
<div style="background-image: url(./image/bg.jpg)">

<!-- 업로드 후 -->
<img src="https://www.thelabyrinth.co.kr/labyrinth/...">
<div style="background-image: url('https://www.thelabyrinth.co.kr/labyrinth/...')">
```

이미지 체크섬으로 중복 업로드를 방지합니다.

## 예시

`example/` 폴더에 예시 미궁이 있습니다.

```
example/
├── labyrinth.json
├── account.json.example  # 복사 후 account.json으로 이름 변경
├── image/
│   ├── title.jpg         # 380x100 미궁 썸네일
│   └── sample.jpg        # 본문 이미지 (업로드 테스트용)
└── page/
    ├── start.html/json   # 시작
    ├── branch.html/json  # 분기
    ├── badend.html/json  # 배드엔딩
    └── ending.html/json  # 엔딩
```

실행 전:
1. `account.json.example`을 `account.json`으로 복사
2. 계정 정보 입력

```bash
node upload.js ./example
```

## 라이선스

MIT
