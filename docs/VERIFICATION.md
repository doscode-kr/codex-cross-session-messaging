# 검증 기록

검증 날짜는 2026-10-08입니다.
검증 환경은 Windows입니다.
Node.js 버전은 20.19.4입니다.
Codex CLI 버전은 0.161.0입니다.
운영 중인 공유 데몬 버전은 0.159.3입니다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 자동 검증 | 24개 통과 · 실패 0개 · 생략 0개 |
| JavaScript 구문과 플러그인 JSON | 통과 |
| Skill Creator의 스킬 검사 | 통과 |
| 실제 공유 데몬의 소켓 연결 | 통과 |
| 실제 공유 데몬의 세션 목록과 현재 작업 ID 조회 | 통과 |
| 별도 설정 폴더의 플러그인 설치 | 통과 |
| 실제 Codex의 설치된 MCP 도구 조회 | 통과 |
| Windows 사용자 전역 설치 | 통과 · 설치됨 · 활성화됨 |

## 실제 Codex 전달 검증

`tests/real-codex.test.mjs`는 실제 Codex App Server를 실행합니다.
이 검증은 별도 임시 `CODEX_HOME`을 사용합니다.
이 검증은 서로 다른 독립 세션 두 개를 생성합니다.
이 검증은 로컬 모형 서버를 사용합니다.
실제 모델 API는 호출하지 않습니다.

- 작업 중인 수신 세션에 `turn/steer`로 메시지를 전달했습니다.
- 대기 중인 수신 세션에 `turn/start`로 메시지를 전달했습니다.
- 두 메시지의 본문이 모델 요청에 포함된 것을 확인했습니다.
- 설치된 플러그인의 `send_message` 도구를 실제 Codex에서 조회했습니다.

메시지 전달 검증은 CLI 0.161.0에서 통과했습니다.
메시지 전달 검증은 별도 실행한 0.159.3에서도 통과했습니다.
운영 중인 사용자 세션에는 검증 메시지를 보내지 않았습니다.

## 동작 검증

- 동시 리더 지정 요청에서 한 세션만 성공했습니다.
- 현재 리더만 역할을 해제하거나 넘겼습니다.
- 다른 프로젝트의 세션에 메시지를 전달했습니다.
- 같은 프로젝트의 세션을 목록 앞에 표시했습니다.
- 원래 발신 세션에 답장했습니다.
- 수신 세션만 읽음 확인을 기록했습니다.
- 즉시 전달 실패를 큐 전달로 바꾸지 않았습니다.
- 전달 결과가 불확실한 메시지를 자동 재전송하지 않았습니다.
- 발신 기록에서 불확실한 전달을 조회했습니다.
- 대기 상태 알림을 한 번만 전달했습니다.
- 새 작업 시작 전의 대기 상태로 완료 알림을 보내지 않았습니다.
- 재시작 때 중단된 전달을 `uncertain`으로 기록했습니다.
- 중단된 마지막 JSONL 기록을 복구했습니다.
- 인증 토큰이 다른 요청을 거부했습니다.
- 동시에 시작한 두 번째 브로커의 기록 접근을 막았습니다.
- 공백이 있는 설치 경로에서 Windows 훅 명령을 실행했습니다.
- 서브에이전트 훅의 부모 ID로 독립 세션을 등록하지 않았습니다.
- 사용자 승인 요청에 브로커가 대신 응답하지 않았습니다.

## 실행 명령

```powershell
$env:CROSS_SESSION_REAL_CODEX_TEST = '1'
npm test
Remove-Item Env:CROSS_SESSION_REAL_CODEX_TEST
npm run check
python C:\Users\dos\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins/cross-session/skills/cross-session
npm run doctor
npm run install:global
codex plugin list --marketplace cross-session-local --json
```

## 설치 위치

플러그인 ID는 `cross-session@cross-session-local`입니다.
전역 설치 경로는 `C:\Users\dos\.codex\plugins\cache\cross-session-local\cross-session\0.1.0`입니다.
Codex의 플러그인 목록에서 `installed: true`를 확인했습니다.
같은 목록에서 `enabled: true`를 확인했습니다.

훅 신뢰 검토는 사용자가 `/hooks`에서 수행해야 합니다.
설치 과정은 훅 신뢰 설정을 자동 승인하지 않았습니다.

## 아직 확인하지 않은 것

macOS에서 직접 실행한 결과는 아직 없습니다.
GitHub Actions에 Windows와 macOS 검증 작업을 구성했습니다.
이 저장소의 GitHub Actions는 아직 실행하지 않았습니다.
실제 모델이 메시지를 이해하고 작업을 완료하는 과정은 이 자동 검증의 범위 밖입니다.
사용자가 훅을 신뢰한 뒤의 여러 터미널 실사용은 아직 확인하지 않았습니다.
