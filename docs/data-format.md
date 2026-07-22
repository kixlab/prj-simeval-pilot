# Data Format

Export ZIP의 `session.json` 최상위 `schemaVersion`은 `simeval-drawing-session-v4`입니다.

ZIP 파일명은 participant ID, task, seed, 시작 시각, 짧은 session ID를 포함합니다. ZIP 내부에는 같은 이름의 root directory가 만들어지며 `session.json`, `README.txt`, 선택된 snapshot PNG, 선택적 think-aloud WebM이 저장됩니다.

## Timeline 기준

모든 연구 데이터는 한 세션의 시작점을 기준으로 한 `elapsedMs`와 절대 시각인 ISO `timestamp`를 함께 가집니다. 인간과 Agent artifact action, think-aloud, phase transition, snapshot은 이 기준으로 시간 정렬할 수 있습니다.

## 주요 필드

- `session`: participant ID, actor, task, seed, 시작/종료 시각, dataset ID, app/prompt/tool version
- `task`: 제시문, phase별 제시문, seed와 초기 seed element ID
- `actions`: artifact diff를 idle 단위로 묶은 action과 전후 snapshot 참조
- `elementMutations`: Human mode의 매 Excalidraw `onChange`에서 기록한 element/property 단위 원본 변화
- `thinkAloudChunks`: Human audio transcript와 word timestamp
- `thinkAloudNotes`: task 종료 후 응답과 명시적 note
- `rationaleRecords`: Human/Agent rationale의 공통 표현과 `startedAtMs`, `endedAtMs`, `availableAtMs`, provenance
- `validationErrors`: export 직전 무결성 검사에서 발견된 오류. 오류가 있어도 raw JSON과 audio export는 계속 진행됨
- `agentTrajectory`: 시간 예산, 판단 번호, 관찰 snapshot 참조, 판단 요약, rationale, batch 내 각 tool call과 실행 결과
- `phaseTransitions`: Adaptive Reframing에서 조건 공개 시각과 전후 snapshot
- `pointerModalities`: 실제 pointerdown에서 감지한 mouse/pen/touch
- `snapshots`: 초기, action 직후, 5초 주기, phase 경계, 최종 full scene
- `outcomeEvaluation`: 별도 평가 데이터가 참조할 안정적인 evaluation/artifact ID
- `finalArtifact`: 최종 scene element와 ZIP 내부 PNG/audio 파일명

## Action과 Snapshot

`elementMutations[]`는 후처리 전 원본 시간 스트림입니다. element마다 별도 항목을 만들며, 같은 callback에서 감지된 변화는 같은 `onChangeBatchId`와 서로 다른 `batchSequence`를 가집니다. `actions[]`는 기존 호환성을 위한 700ms idle-flush 단위 요약이므로 원본 변화 순서 분석에는 `elementMutations[]`를 사용합니다.

각 `actions[]` 항목은 `beforeSnapshotId`와 `afterSnapshotId`를 가집니다. `beforeSnapshotId`는 pending action이 처음 시작될 때 고정되므로 action 도중 periodic snapshot이 생성되어도 바뀌지 않습니다. `artifactDiff`에는 추가, 수정, 삭제된 object ID가 들어갑니다. Task 2에서 초기 제공 요소가 대상이면 해당 ID가 `seedElementImpacts`에도 기록됩니다.

원본 scene을 보존하기 위해 snapshot은 full Excalidraw elements를 저장합니다. 분석 시에는 action의 compact diff를 먼저 읽고, 세부 시각 상태가 필요한 action에서만 연결된 snapshot을 로드하는 방식을 권장합니다.

PNG는 세션 중 메모리에 누적하지 않습니다. Export 시 initial/action/phase-boundary/final snapshot을 하나씩 렌더링해 ZIP stream에 추가합니다. 5초 periodic snapshot은 scene JSON만 저장합니다. 각 렌더링된 snapshot은 `imageFileName`으로 ZIP 내부 PNG를 참조합니다.

## Audio

음성은 10초 단위 chunk로 STT에 전송되고 metadata와 transcript가 `thinkAloudChunks`에 기록됩니다. raw audio는 JSON에 중복 삽입하지 않고 ZIP의 `audio/think-aloud.webm`으로 저장합니다. STT 인증 또는 네트워크 오류가 발생해도 chunk 크기와 오류 정보는 남습니다.

각 audio chunk는 녹음 flush 직후 고유 sequence를 예약하고 `pending` 상태로 먼저 배열에 들어갑니다. STT 응답은 완료 순서와 무관하게 chunk ID로 기존 항목을 갱신합니다. export 시에는 sequence 순으로 정렬하고 duplicate sequence를 별도로 검사합니다.

## Agent 종료 조건

Agent 세션의 `session.agentConfig`에는 사용 모델, prompt/tool schema version과 hash, 전체 시간 예산, finalization window가 저장됩니다. `session.completionReason`은 `agent_finish`, `time_budget`, `cancelled`, `agent_error`, `manual` 중 실제 종료 경로를 기록합니다. 최대 turn 수는 없으며, `agentTrajectory.decision`은 제한값이 아니라 시간순 판단 번호입니다.

각 decision은 `observationId`, `observationSnapshotId`, `observedAtMs`, request 시작/종료/기간을 기록합니다. Agent에게 전송된 PNG data URL은 세션 중 보관하지 않고, observation이 참조한 snapshot PNG를 export 시 재생성합니다.

한 decision의 tool call은 `toolCallIndex`의 0-based 순서대로 동기 실행됩니다. 각 trajectory entry에는 `toolCallCount`, `toolExecutionId`, `executionStatus`, 실행 시작·종료·기간이 기록됩니다. 앞선 call이 실패하거나 exception을 발생시키면 후속 call은 실행하지 않고 `executionStatus: "skipped"`로 기록하며, 실패한 call의 index와 execution ID를 참조합니다. skipped call은 실제 artifact action을 만들지 않습니다. 실패한 batch 뒤에는 다음 decision cycle로 이동하여 scene summary와 screenshot을 새로 관찰합니다.

실제로 scene을 바꾼 Agent action에는 가능한 경우 `decisionNumber`, `toolCallIndex`, `toolExecutionId`가 함께 저장되어 trajectory의 실행 call과 연결할 수 있습니다.
