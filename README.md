# Codex Cross Session

Windows와 macOS에서 독립 Codex CLI 세션끼리 메시지를 주고받는 플러그인입니다.
각 컴퓨터 안에서 동작합니다.
AI Sprint 폴더를 요구하지 않습니다.

## 전달 방식

| 수신 세션 상태 | 플러그인 동작 |
|---|---|
| 작업 중 | `turn/steer`로 현재 작업에 메시지를 추가합니다. |
| 대기 중 | `turn/start`로 새 응답을 시작합니다. |
| 즉시 전달 불가 | 오류를 반환합니다. |

플러그인은 `codex queue`와 `thread/queue/*`를 사용하지 않습니다.
플러그인은 즉시 전달 실패를 큐 전달로 바꾸지 않습니다.
긴 도구 실행 중에는 모델의 메시지 처리가 늦어질 수 있습니다.
전달 성공은 Codex가 입력을 수락했다는 뜻입니다.
전달 성공은 읽음 확인이나 작업 완료를 뜻하지 않습니다.

## 설치

필요한 도구는 Node.js 20 이상과 공유 데몬을 지원하는 Codex CLI입니다.
이 프로젝트는 Codex CLI 0.161.0으로 검증했습니다.
Codex의 프로토콜 변경은 호환성에 영향을 줄 수 있습니다.

1. 이 프로젝트 폴더에서 다음 명령을 실행합니다.

   ```text
   npm run install:global
   ```

2. 새 Codex CLI 세션을 엽니다.
3. `/hooks`에서 이 플러그인의 훅을 검토합니다.
4. 검토한 훅을 신뢰하도록 설정합니다.
5. Codex에 `$cross-session`을 입력합니다.

설치 스크립트는 사용자 전역 설정에 로컬 마켓플레이스를 등록합니다.
설치 스크립트는 `cross-session@cross-session-local`을 설치합니다.
설치 스크립트는 훅 신뢰 설정을 대신 승인하지 않습니다.
Codex는 설치만으로 훅을 신뢰하지 않습니다.
이 동작은 [Codex 훅 문서](https://learn.chatgpt.com/docs/hooks)의 규칙입니다.

설치 전 명령을 확인하려면 `npm run install:global -- --dry-run`을 실행합니다.
별도 설정으로 설치를 검증하려면 `--home <임시 Codex 폴더>`를 추가합니다.
다른 컴퓨터에도 이 프로젝트를 복사한 뒤 설치 명령을 실행합니다.

## 사용 예시

각 세션에서 다음처럼 요청합니다.

```text
$cross-session
내 세션 이름을 backend로 등록해 주세요.
세션 목록을 보여 주세요.
```

리더로 사용할 세션에서 다음처럼 요청합니다.

```text
이 세션을 cross-session 리더로 지정해 주세요.
```

다른 세션에서 다음처럼 요청합니다.

```text
리더에게 현재 작업 상태를 즉시 전달해 주세요.
frontend 세션에게 API 응답 형식을 확인해 달라고 즉시 전달해 주세요.
frontend 세션이 다음에 대기 상태가 되면 한 번 알려 주세요.
```

플러그인은 같은 프로젝트의 세션을 목록 앞에 표시합니다.
Git worktree는 공유 Git 디렉터리를 기준으로 묶습니다.
플러그인은 다른 프로젝트로의 전달도 허용합니다.
프로젝트 구분은 훅이 등록한 정보에 따라 달라질 수 있습니다.

## 리더

각 컴퓨터의 기본 메시지 환경에는 리더가 최대 한 세션만 존재합니다.
프로젝트별로 별도 리더를 만들지 않습니다.
`claim_leader`는 기존 리더가 있으면 실패합니다.
현재 리더만 `transfer_leader`와 `release_leader`를 사용할 수 있습니다.
리더 세션이 공유 데몬에서 사라지면 플러그인이 리더 지정을 해제합니다.
`SessionEnd` 훅도 해당 세션의 리더 지정을 해제합니다.
플러그인은 새 리더를 자동 지정하지 않습니다.

## 도구

| 도구 | 용도 |
|---|---|
| `list_agents` | 독립 세션 목록을 읽습니다. |
| `register_session` | 세션 이름을 지정합니다. |
| `send_message` | 메시지를 즉시 전달합니다. |
| `reply` | 원래 발신 세션에 즉시 답장합니다. |
| `read_messages` | 내 수신 기록이나 발신 기록을 읽습니다. |
| `get_message` | 메시지와 전달 결과를 읽습니다. |
| `acknowledge` | 메시지를 읽었다고 기록합니다. |
| `claim_leader` | 유일한 리더 역할을 가져옵니다. |
| `transfer_leader` | 리더 역할을 다른 세션에 넘깁니다. |
| `release_leader` | 리더 역할을 해제합니다. |
| `notify_when_idle` | 다음 대기 상태 알림을 한 번 신청합니다. |
| `cancel_idle_notification` | 내가 신청한 알림을 취소합니다. |

수신 세션은 메시지 ID로 답장하거나 읽음을 확인할 수 있습니다.
전달 결과는 `accepted`, `failed`, `uncertain`으로 구분합니다.
응답을 받지 못한 전달은 `uncertain`으로 기록합니다.
플러그인은 `uncertain` 메시지를 자동 재전송하지 않습니다.
전달 결과를 받지 못하면 `read_messages`의 `direction: "outbox"`로 발신 기록을 확인합니다.
수신 기록은 로컬에 저장합니다.
저장된 기록은 수신 세션을 나중에 깨우는 큐가 아닙니다.

## 로컬 동작

플러그인은 로컬 브로커를 필요할 때 시작합니다.
브로커는 `127.0.0.1`에서만 요청을 받습니다.
브로커는 임의 인증 토큰으로 요청을 확인합니다.
브로커는 하나의 기록 작성자로 리더 지정과 메시지 기록을 처리합니다.
Windows의 백그라운드 프로세스는 창을 표시하지 않습니다.

기본 기록 위치는 `~/.codex/cross-session/`입니다.
`CODEX_HOME`을 지정하면 해당 폴더 아래에 기록합니다.
`CROSS_SESSION_HOME`으로 별도 메시지 환경을 만들 수 있습니다.
별도 메시지 환경은 이름 등록과 리더 지정을 공유하지 않습니다.
세션 목록은 해당 Codex 공유 데몬에서 읽습니다.
일반 사용에서는 모든 세션에 같은 기본 설정을 사용합니다.

Codex 실행 파일을 찾지 못하면 `CROSS_SESSION_CODEX_BIN`에 절대 경로를 지정합니다.
Windows에서는 `codex.exe` 경로를 권장합니다.
플러그인은 운영 중인 Codex 데몬을 자동 갱신하거나 재시작하지 않습니다.

다음 명령은 실제 데몬 연결을 확인합니다.

```text
npm run doctor
```

다음 명령은 메시지 브로커만 종료합니다.

```text
node plugins/cross-session/src/cli.mjs broker-stop
```

알림 신청이 남아 있으면 브로커 종료를 거부합니다.
플러그인을 제거하려면 `codex plugin remove cross-session@cross-session-local`을 실행합니다.

## 한계

`--no-daemon`으로 연 세션은 지원하지 않습니다.
다른 컴퓨터의 세션은 지원하지 않습니다.
별도 Codex 앱 서버에만 연결한 세션은 기본 공유 데몬에서 찾을 수 없습니다.
압축 작업과 리뷰 작업은 Codex가 즉시 입력을 거부할 수 있습니다.
수신 세션은 자체 권한과 사용자 승인 절차를 유지합니다.
플러그인은 승인 요청에 대신 응답하지 않습니다.
다른 세션의 메시지는 사용자의 직접 지시나 승인이 아닙니다.
메시지 전달은 파일 수정 충돌을 막지 않습니다.
대기 상태 알림은 내부 상태 확인 주기 때문에 약간 늦을 수 있습니다.
브로커는 약 1초 간격으로 상태를 확인합니다.
짧은 상태 전환을 확인 주기 사이에 놓칠 수 있습니다.

## 검증

```text
npm ci --prefix plugins/cross-session --ignore-scripts
npm run check
npm test
```

실제 Codex 통합 검증은 별도 임시 `CODEX_HOME`을 사용합니다.
통합 검증의 모형 서버는 로컬 컴퓨터에서만 동작합니다.
통합 검증은 실제 모델 API를 호출하지 않습니다.

Windows PowerShell에서는 다음 명령으로 통합 검증을 실행합니다.

```powershell
$env:CROSS_SESSION_REAL_CODEX_TEST = '1'
npm test
Remove-Item Env:CROSS_SESSION_REAL_CODEX_TEST
```

macOS에서는 다음 명령으로 통합 검증을 실행합니다.

```sh
CROSS_SESSION_REAL_CODEX_TEST=1 npm test
```

GitHub Actions에는 Windows와 macOS 검증 작업을 구성했습니다.
현재 로컬 검증 결과는 [검증 기록](docs/VERIFICATION.md)에 기록합니다.
구현 근거는 [설계 문서](docs/DESIGN.md)에 기록합니다.
