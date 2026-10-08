# Codex Cross Session

[English](README.md)

같은 컴퓨터의 독립 Codex CLI 세션끼리 메시지를 보내는 플러그인입니다.
플러그인은 Codex 공유 데몬과 로컬 Node.js 브로커를 사용합니다.
플러그인은 특정 개발 절차를 요구하지 않습니다.

| 수신 세션 상태 | 전달 방식 |
|---|---|
| 작업 중 | `turn/steer`가 현재 작업에 입력을 추가합니다. |
| 대기 중 | `turn/start`가 새 작업을 시작합니다. |
| 직접 입력 불가 | 도구가 오류를 반환합니다. |

플러그인은 전달에 완료 큐나 중단을 사용하지 않습니다.
긴 도구 호출은 메시지 처리를 늦출 수 있습니다.
`accepted`는 Codex가 입력을 수락했다는 뜻입니다.
`accepted`는 읽음이나 작업 완료를 뜻하지 않습니다.
플러그인은 `uncertain` 메시지를 자동 재전송하지 않습니다.

## 요구사항

- Node.js 20 이상.
- 공유 데몬과 플러그인을 지원하는 Codex CLI.
- 같은 컴퓨터에서 실행하는 독립 CLI 세션.

기존 Windows 검증은 Codex CLI 0.161.0을 사용했습니다.
CI 설정은 Windows와 macOS의 Node.js 20과 22를 대상으로 합니다.
기존 검증 기록에는 macOS 실행 결과가 없습니다.
기존 검증 기록에는 CI 실행 결과가 없습니다.
[호환성과 검증 한계](docs/VERIFICATION.md)를 확인하세요.

## 설치

1. 사용자는 저장소를 복제합니다.

   ```text
   git clone https://github.com/doscode-kr/codex-cross-session-messaging.git
   ```

2. 사용자는 저장소 폴더로 이동합니다.

   ```text
   cd codex-cross-session-messaging
   ```

3. 사용자는 설치 명령을 확인합니다.

   ```text
   node scripts/install.mjs --dry-run
   ```

4. 사용자는 플러그인을 설치합니다.

   ```text
   npm run install:global
   ```

5. 사용자는 새 Codex CLI 세션을 엽니다.
6. 사용자는 `/hooks`에서 플러그인 훅을 검토합니다.
7. 사용자는 검토한 훅을 신뢰하도록 설정합니다.
8. 사용자는 Codex에 `$cross-session`을 입력합니다.

설치 스크립트는 현재 폴더를 `cross-session-local` 마켓플레이스로 등록합니다.
설치 스크립트는 사용자 Codex 설정에 `cross-session@cross-session-local`을 설치합니다.
설치 스크립트는 훅 신뢰를 승인하지 않습니다.
사용자는 업데이트를 위해 원본 폴더를 유지합니다.
별도 설정 설치에는 `node scripts/install.mjs --home <임시-폴더>`를 사용합니다.
PowerShell에서 옵션을 지정할 때는 직접 Node.js 명령을 사용합니다.
npm의 PowerShell 실행 파일은 `--dry-run` 같은 옵션을 소비할 수 있습니다.

## 사용

각 세션에서 이름을 등록합니다.

```text
$cross-session
내 세션 이름을 backend로 등록해 주세요.
세션 목록을 보여 주세요.
```

리더 역할이 필요하면 해당 세션에서 요청합니다.

```text
이 세션을 cross-session 리더로 지정해 주세요.
```

다른 세션에서 메시지를 보냅니다.

```text
리더에게 현재 작업 상태를 전달해 주세요.
frontend 세션에게 API 응답 형식을 확인해 달라고 전달해 주세요.
frontend 세션이 다음에 대기 상태가 되면 한 번 알려 주세요.
```

세션 목록은 같은 프로젝트의 세션을 먼저 표시합니다.
Git worktree는 공통 Git 폴더로 프로젝트를 구분합니다.
사용자는 다른 프로젝트에도 메시지를 보낼 수 있습니다.
메시지는 파일 수정 충돌을 막지 않습니다.
수신 세션은 자체 권한을 유지합니다.
수신 세션은 사용자 작업 범위를 유지합니다.
동료 세션의 메시지는 사용자 승인이 아닙니다.

## 도구

| 도구 | 기능 |
|---|---|
| `list_agents` | 독립 세션 목록을 읽습니다. |
| `register_session` | 현재 세션의 이름을 지정합니다. |
| `send_message` | 메시지를 즉시 보냅니다. |
| `reply` | 메시지 발신 세션에 답장합니다. |
| `read_messages` | 수신 기록이나 발신 기록을 읽습니다. |
| `get_message` | 메시지와 전달 결과를 읽습니다. |
| `acknowledge` | 수신 세션의 읽음을 기록합니다. |
| `claim_leader` | 사용자 지정 후 리더 역할을 받습니다. |
| `transfer_leader` | 현재 리더 역할을 넘깁니다. |
| `release_leader` | 현재 리더 역할을 해제합니다. |
| `notify_when_idle` | 다음 대기 상태 알림을 한 번 신청합니다. |
| `cancel_idle_notification` | 현재 세션의 알림 신청을 취소합니다. |

MCP 도구 결과는 기본으로 짧은 문장을 표시합니다.
전체 결과는 `structuredContent`에 포함됩니다.
전체 JSON을 문장 출력에서 보려면 도구 호출에 `detail: true`를 지정합니다.
전체 메시지는 `get_message`에 `message_id`와 `detail: true`를 지정하여 읽습니다.
전달 응답을 잃으면 `read_messages`에 `direction: "outbox"`와 `detail: true`를 지정합니다.
Codex는 전체 구조화 데이터나 동료 세션 문맥을 표시할 수 있습니다.
이 옵션은 메시지 전달과 저장 데이터와 권한을 변경하지 않습니다.
세션은 결과와 필요한 질문과 작업을 막는 오류에 답장합니다.
세션은 수신 확인만 담은 답장을 피합니다.

현재 리더만 역할을 넘기거나 해제할 수 있습니다.
기본 메시지 환경에는 프로젝트 전체에서 리더가 하나만 존재합니다.
리더가 공유 데몬에서 사라지면 브로커가 역할을 해제합니다.
브로커는 새 리더를 자동 지정하지 않습니다.

전달 결과는 `accepted`, `failed`, `uncertain`입니다.
전달 응답을 잃으면 `read_messages`에 `direction: "outbox"`를 지정합니다.
사용자는 재전송 전에 저장된 메시지를 확인합니다.
대기 알림은 상태 정보입니다.
대기 알림은 작업 완료의 증거가 아닙니다.
브로커는 신청된 세션을 약 1초마다 확인합니다.
브로커는 짧은 상태 전환을 놓칠 수 있습니다.

## 로컬 데이터와 설정

브로커는 `127.0.0.1`에서 요청을 받습니다.
브로커는 임의 인증 토큰을 확인합니다.
브로커는 메시지와 전달 결과를 로컬 JSONL 기록에 저장합니다.
플러그인은 자동 보관 기한을 제공하지 않습니다.
플러그인은 기록 파일을 자동 분할하지 않습니다.
로그를 공유하기 전에 [개인정보와 보안 안내](SECURITY.md)를 확인하세요.

| 설정 | 기능 |
|---|---|
| 기본값 | `~/.codex/cross-session/`에 데이터를 저장합니다. |
| `CODEX_HOME` | `<CODEX_HOME>/cross-session/`에 데이터를 저장합니다. |
| `CROSS_SESSION_HOME` | 해당 폴더를 메시지 환경으로 사용합니다. |
| `CROSS_SESSION_CODEX_BIN` | Codex 실행 파일이나 JavaScript 진입 파일의 절대 경로를 지정합니다. |

이름과 리더를 공유하는 세션은 같은 설정을 사용합니다.
별도 메시지 폴더는 이름 등록과 리더 상태를 공유하지 않습니다.
Windows에서는 `codex.exe` 경로를 권장합니다.
플러그인은 운영 중인 Codex 데몬을 재시작하지 않습니다.
플러그인은 운영 중인 Codex 데몬을 업데이트하지 않습니다.

## 업데이트와 삭제

사용자는 [업데이트 절차](docs/OPERATIONS.ko.md)를 따릅니다.
사용자는 [삭제 절차](docs/UNINSTALL.ko.md)를 따릅니다.
플러그인 삭제와 로컬 데이터 삭제는 별도 작업입니다.

## 확인과 지원

다음 명령은 메시지를 보내지 않고 운영 데몬을 확인합니다.

```text
npm run doctor
```

다음 명령은 저장소 검사를 실행합니다.

```text
npm ci --prefix plugins/cross-session --ignore-scripts
npm run check
npm test
```

실제 Codex 통합 검증은 별도 실행 설정이 필요합니다.
통합 검증은 임시 `CODEX_HOME`을 사용합니다.
통합 검증은 로컬 모형 서버를 사용합니다.
사용자는 [검증 안내](docs/VERIFICATION.md)를 확인합니다.

`--no-daemon` 세션은 지원하지 않습니다.
다른 컴퓨터의 세션은 지원하지 않습니다.
별도 앱 서버에만 연결한 세션은 공유 데몬 목록에 나오지 않습니다.
Codex는 압축이나 검토 중에 직접 입력을 거부할 수 있습니다.
플러그인은 승인 요청에 대신 응답하지 않습니다.

오류는 [이슈 목록](https://github.com/doscode-kr/codex-cross-session-messaging/issues)에 보고하세요.
보고에는 운영체제와 Node.js 버전과 Codex 버전을 포함합니다.
보고에는 개인정보를 제거한 오류를 포함합니다.
보고에는 메시지 본문이나 인증 토큰을 포함하지 않습니다.
보안 문제는 [SECURITY.md](SECURITY.md)를 확인하세요.
[기여 안내](CONTRIBUTING.md)와 [변경 기록](CHANGELOG.md)과 [배포 확인표](docs/RELEASE.md)를 제공합니다.

## 라이선스

프로젝트는 [MIT 라이선스](LICENSE)를 사용합니다.
의존성 `ws`는 자체 MIT 라이선스를 사용합니다.
