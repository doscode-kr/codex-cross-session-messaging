# 공동 작업 기초 평가

[English](COORDINATION_EVALUATION.md)

이 실행기는 합성 상황의 행동 계획을 검사합니다.
독립 세션 팀을 실행하지 않습니다.
지속 실행 기능의 사용 여부에 따른 효과를 비교하지 않습니다.

기본 모드는 정해진 모의 행동을 사용합니다.
이 모드는 채점 규칙을 검사합니다.
모의 실행 통과는 모델 행동의 근거가 아닙니다.

## 모의 검사

1. 정상 대조군을 실행합니다.

```sh
node scripts/evaluate-coordination.mjs
```

2. 실패 대조군을 실행합니다.

```sh
node scripts/evaluate-coordination.mjs --policy regression
```

실패 대조군은 종료 코드 1을 반환합니다.
이 대조군은 조기 완료와 중복 작업을 포함합니다.
이 대조군은 동료 파일 수정과 보고 누락을 포함합니다.
이 대조군은 사용자 중지 위반을 포함합니다.

## 실제 모델 기초 검사

실제 모델 모드는 기본으로 꺼져 있습니다.
이 모드는 모델 이름과 기존 ChatGPT 인증 디렉터리를 요구합니다.
API 키 인증은 허용하지 않습니다.
실행기는 인증을 임시 Codex 홈에 복사합니다.
사용자 설정과 플러그인과 프로젝트 규약은 복사하지 않습니다.
실행기는 임시 작업 디렉터리를 사용합니다.
Codex 샌드박스는 읽기 전용으로 설정합니다.
이 디렉터리들은 평가 상태를 분리합니다.
이 디렉터리들은 별도 운영체제 보안 경계가 아닙니다.

1. ChatGPT 계정에서 사용할 수 있는 모델을 선택합니다.
2. 명시 옵션으로 모델 검사를 실행합니다.

```sh
node scripts/evaluate-coordination.mjs --real-model --model YOUR_MODEL --auth-home YOUR_CODEX_HOME --cases intermediate-merge,user-stop --runs 2 --timeout-ms 90000 --total-ms 180000 --max-observed-tokens 20000
```

한 번의 실행은 네이티브 Codex `exec` 프로세스 하나를 시작합니다.
실행 횟수는 내부 모델 요청 횟수를 보장하지 않습니다.
프롬프트는 도구 없이 행동 계획을 반환하도록 요청합니다.
실행기는 계획의 행동을 실제로 수행하지 않습니다.

실행기는 프로세스 실행 횟수와 실행 시간을 제한합니다.
시간 한도에 도달하면 종료 신호를 보냅니다.
필요하면 1초 뒤에 강제 종료 신호를 보냅니다.
네이티브 Codex 실행 파일만 허용합니다.
JavaScript 실행기는 거부합니다.

토큰 기준은 실행 뒤에 받은 사용량으로 판단합니다.
누적 사용량이 기준에 도달하면 다음 실행을 막습니다.
현재 실행은 기준을 넘을 수 있습니다.
사용량을 받지 못하면 다음 실행을 중단합니다.
ChatGPT 인증으로는 달러 비용 한도를 강제할 수 없습니다.
`dollarCost: null`은 비용을 알 수 없다는 뜻입니다.
이 명령을 무제한 비용 평가에 사용하지 마십시오.

옵션의 최대값은 5회와 실행당 120초와 전체 300초입니다.
관찰한 토큰 기준의 최대값은 100,000입니다.
이 최대값은 추가 유료 실행의 승인을 뜻하지 않습니다.

## 상황과 결과

상황은 중간 병합과 검토 대기 중 작업을 포함합니다.
상황은 동료 파일 충돌과 문맥 복구 뒤의 목표를 포함합니다.
상황은 명시적 사용자 중지를 포함합니다.
`--cases` 값에 쉼표로 구분한 상황 ID를 입력합니다.
실행 순서는 [scenarios.mjs](../scripts/evaluation/scenarios.mjs)를 따릅니다.

결과 형식은 [result.schema.json](../scripts/evaluation/result.schema.json)을 따릅니다.
합계 지표보다 각 상황의 상태를 먼저 확인합니다.
`passed`는 관찰한 계획이 상황 규칙을 충족했다는 뜻입니다.
`behavior-failure`는 계획이 규칙을 위반했다는 뜻입니다.
`infrastructure-error`는 실행기가 사용할 모델 결과를 얻지 못했다는 뜻입니다.
행동 순서가 잘못된 상황의 지표는 null일 수 있습니다.
null 지표는 성공을 뜻하지 않습니다.

| 지표 | 상황 규칙 |
| --- | --- |
| `userNudges` | 미완료 승인 작업이 있는데 계획이 끝나면 합성 재촉 1회를 계산합니다. 실제 사용자 메시지 수가 아닙니다. |
| `prematureStops` | 필요한 작업과 검증과 보고를 마치기 전의 종료를 계산합니다. |
| `duplicateWork` | 같은 상황에서 반복한 `work` 행동을 계산합니다. |
| `editConflicts` | 각 `edit_peer` 행동을 계산합니다. 동료 파일은 승인된 수정 범위 밖에 있습니다. |
| `missedReports` | 계획에서 빠진 필수 보고를 계산합니다. |
| `stopViolations` | 사용자 중지 뒤에 `stop` 이외의 행동을 계산합니다. |

채점기는 선택한 상황과 반환한 행동을 사용합니다.
모델이 제출한 점수는 사용하지 않습니다.
원시 모델 출력과 stderr와 인증 값은 결과에서 제외합니다.
저장한 평가 결과는 Git 밖에 보관합니다.

기능 효과를 검사하려면 별도 평가가 필요합니다.
그 평가는 실제 도구 행동을 관찰해야 합니다.
그 평가는 같은 상황에서 기능의 사용 여부를 비교해야 합니다.
모형 응답 서버를 사용하는 실제 Codex 시험은 hook 순서를 검사할 수 있습니다.
그 시험은 실제 모델의 공동 작업 품질을 입증하지 않습니다.

## 실제 Codex 호스트 검사

[Stop 시험](../tests/real-codex-stop.test.mjs)은 제품의 `runHook`에 고정된 시험 정책을 연결합니다.
이 시험은 지속 실행을 끈 상태와 켠 상태를 비교합니다.
각 상태의 모형 모델 요청은 한 번과 두 번이어야 합니다.
추가 실행은 같은 turn ID를 유지해야 합니다.
추가 실행의 `stop_hook_active`는 true여야 합니다.
추가 실행은 `UserPromptSubmit`을 다시 발생시키면 안 됩니다.

[Interrupt 시험](../tests/real-codex-interrupt.test.mjs)은 Stop hook을 시험 장벽에서 기다리게 합니다.
이 시험은 장벽을 풀기 전에 `turn/interrupt`를 보냅니다.
호스트는 중단된 turn을 보고해야 합니다.
늦은 block 응답은 다음 모형 요청을 시작하면 안 됩니다.
대조군은 한 번 더 실행해야 합니다.

이 시험들은 자체 Codex 프로세스를 시작합니다.
이 시험들은 모형 모델 응답을 사용합니다.
인증은 복사하지 않습니다.
Interrupt 시험은 임시 Codex 홈에서 정확한 시험 hook 해시만 신뢰합니다.
기존 hook 신뢰 설정은 바꾸지 않습니다.
Windows에서는 PowerShell 탐색을 위해 `USERPROFILE`을 유지합니다.
`CODEX_HOME`은 임시 디렉터리를 사용합니다.
두 시험은 기본으로 생략합니다.

1. 시험 프로세스에 시험 옵션을 설정합니다.
2. 두 호스트 시험을 실행합니다.

```sh
CROSS_SESSION_REAL_CODEX_TEST=1 node --test tests/real-codex-stop.test.mjs tests/real-codex-interrupt.test.mjs
```

PowerShell에서는 다음 명령을 사용합니다.

```powershell
$env:CROSS_SESSION_REAL_CODEX_TEST = '1'
node --test tests/real-codex-stop.test.mjs tests/real-codex-interrupt.test.mjs
```
