# LAST SIGNAL ONLINE

2~8명이 6자리 방 코드로 접속해 플레이하는 온라인 전략 카드게임입니다.

## 실행

Windows에서는 `START_GAME.bat`을 더블클릭하면 서버와 브라우저가 함께 열립니다. 서버 창은 게임이 끝날 때까지 닫지 마세요.

Node.js 18 이상이 설치된 컴퓨터에서 프로젝트 폴더를 연 뒤 다음 명령을 실행합니다.

```powershell
npm start
```

브라우저에서 `http://localhost:3000`을 열면 됩니다. 같은 와이파이의 다른 기기는 서버 컴퓨터의 내부 IP와 `:3000`을 붙인 주소로 접속할 수 있습니다.

## 인터넷에 공개하기

이 프로젝트는 별도 패키지 설치가 필요 없는 Node.js 서버입니다. Node.js 웹 서비스를 지원하는 호스팅에 전체 폴더를 올리고 시작 명령을 `npm start`로 지정하면 됩니다. 호스팅이 발급한 주소를 친구에게 공유하면 서로 다른 장소에서도 방 코드로 참가할 수 있습니다.

Render에서는 저장소를 연결한 뒤 Blueprint 배포를 선택하면 루트의 `render.yaml` 설정이 자동으로 적용됩니다. 무료 인스턴스와 싱가포르 리전, `npm start` 실행 명령이 미리 지정되어 있습니다.

## 서버 재시작 후에도 방 유지하기

Supabase를 연결하면 Render가 재시작되더라도 방, 플레이어, 손패, HP, 현재 차례와 남은 타이머를 불러옵니다.

1. Supabase에서 무료 프로젝트를 만듭니다.
2. Supabase의 `SQL Editor`를 열고 `supabase-setup.sql` 전체를 실행합니다.
3. Supabase 프로젝트의 `Settings > API Keys`에서 Project URL과 Secret key를 확인합니다.
4. Render 서비스의 `Environment`에 다음 값을 등록합니다.
   - `SUPABASE_URL`: Supabase Project URL
   - `SUPABASE_SECRET_KEY`: `sb_secret_`로 시작하는 서버용 Secret key
5. Render에서 `Save Changes` 후 최신 버전을 다시 배포합니다.
6. 배포 주소 뒤에 `/api/health`를 붙여 열었을 때 `"persistence":"supabase"`가 표시되는지 확인합니다.

`SUPABASE_SECRET_KEY`는 절대로 `online.html`, GitHub 코드 또는 채팅에 적지 마세요. 이 값이 없으면 게임은 기존과 같이 메모리에만 방을 저장합니다. 예전 방식의 `service_role` 키를 사용하는 경우 Render 환경변수 이름을 `SUPABASE_SERVICE_ROLE_KEY`로 등록해도 작동합니다.

## 파일

- `online.html`: 온라인 대기실과 게임 화면
- `server.js`: 방, 실시간 동기화, 비공개 손패, 전투 판정
- `supabase-setup.sql`: 서버 재시작 복구용 데이터베이스 테이블 생성문
- `index.html`: 서버 없이 플레이하는 AI 로컬 프로토타입
