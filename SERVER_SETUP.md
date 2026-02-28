# POKUPOKU 무료 백엔드 시작 가이드 (Supabase)

## 1) 왜 Supabase
- 소수 사용자 기준 무료 플랜으로 시작 가능
- 이메일 로그인 + Postgres + Row Level Security 내장
- 정적 프론트엔드(현재 구조)와 연결이 쉬움

## 2) 지금 이 레포에 추가된 것
- `supabase/schema.sql`: 커플/멤버/공유주기 데이터 테이블 + RLS 정책
- `config.example.js`: 브라우저에서 읽을 Supabase 설정 템플릿
- `.gitignore`: `config.js`(실키) 커밋 방지

## 3) Supabase 콘솔에서 해야 할 일
1. Supabase 프로젝트 생성
2. Authentication > Providers > Anonymous Sign-Ins 활성화
3. Authentication > URL Configuration 에 현재 앱 주소 등록
   - Site URL: 현재 실행 주소 (예: `http://localhost:5500`)
   - Redirect URLs: 같은 주소 추가
4. SQL Editor에 `supabase/schema.sql` 전체 실행
5. Project Settings > API 에서 아래 값 복사
   - Project URL
   - anon public key

## 4) 로컬 연결 준비
1. 프로젝트 루트에 `config.js` 생성 (`config.example.js` 복사)
2. 값 채우기

```js
window.POKUPOKU_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_ID.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
};
```

## 5) 현재 앱에 이미 반영된 기능
- 초대 코드 생성(닉네임 + 6자리 비밀번호)
- 초대 코드 입력으로 조인
- 로컬 + 원격 동기화
  - 저장 시 Supabase 업서트
  - 연결 안 된 상태는 localStorage fallback
- 실시간 반영
  - 같은 커플 데이터 변경 시 자동 pull
- 연결 해제/로그아웃

## 6) 충돌 처리 규칙
- 기본 정책: 최신 `updated_at` 우선(last-write-wins)
- 로컬보다 서버가 최신이면 서버값으로 갱신
- 오프라인 중 변경은 로컬에 저장 후, 재연결 시 업로드
