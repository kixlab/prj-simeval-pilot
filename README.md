# Simeval Drawing Pilot

Excalidraw 기반의 인간 drawing + think-aloud pilot data collection 도구입니다. 현재 버전은 인간 참가자 세션 실행에 초점을 두며, Agent task runner는 포함하지 않습니다. 다만 동일한 canvas action schema로 Agent를 연결할 수 있는 브라우저 API를 제공합니다.

## 실행

```bash
npm install
cp .env.example .env.local
npm run dev
```

Google Speech-to-Text를 사용하려면 `GOOGLE_APPLICATION_CREDENTIALS` 또는 `.env.local`의 관련 값을 설정해야 합니다. 인증이 없어도 drawing, text note, raw audio 녹음과 JSON export는 사용할 수 있으며 STT 결과만 실패 상태로 기록됩니다.

## 포함된 task

1. Free Creation: 빈 canvas와 seed prompt
2. Open-ended Interpretation: 사전 배치된 시각 요소의 재해석
3. Conceptual Synthesis: 두 개념의 통합과 종료 전 설명
4. Adaptive Reframing: Phase 1 작업 후 새로운 조건 공개 및 수정

Seed는 random assignment 또는 manual selection을 지원합니다. Task 2의 초기 요소에는 seed ID가 들어가며 수정 또는 삭제된 seed element ID가 action에 기록됩니다.

## 수집 데이터

- session 및 task/seed metadata
- 700ms idle 단위의 인간 artifact action
- 각 action 직후의 full scene snapshot과 before/after snapshot ID
- 5초 주기 snapshot, 초기/최종/phase 전환 snapshot
- text note, 연속 음성 chunk, STT 결과 및 오류
- mouse, touch, pen pointer modality
- 최종 Excalidraw scene과 PNG data URL

세션 종료 후 JSON과 raw audio를 각각 내려받습니다. JSON 구조는 [`docs/data-format.md`](docs/data-format.md)에 설명되어 있습니다.

## 미래 Agent API

세션이 열린 브라우저에서 `window.simevalAgentApi`를 사용할 수 있습니다.

```js
const agent = window.simevalAgentApi;
agent.addShape("rectangle", 100, 100, 240, 120, { backgroundColor: "#ffd43b" });
agent.addLine([[0, 0], [30, 20], [80, 10]], { freeDraw: true, strokeColor: "#1971c2" });
agent.addText(130, 130, "concept");
agent.submitThinkAloud("I am connecting the two visual ideas.");
```

Agent mutation도 인간 action과 같은 snapshot timeline에 기록되지만 `actorType: "agent"`로 분리됩니다. Agent가 네 task를 자동 수행하는 orchestration과 prompt는 추후 별도로 추가합니다.

## 태블릿

UI는 touch/pen 입력을 막지 않으며 화면 폭에 따라 task panel을 canvas 위쪽으로 이동합니다. 세션 setup에서 주 입력 장치를 기록하고 실제 pointer event의 `pointerType`도 별도로 저장합니다.
