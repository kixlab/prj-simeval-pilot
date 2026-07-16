# Simeval Drawing Pilot

Excalidraw 기반의 Human/Agent drawing process pilot data collection 도구입니다. 첫 화면에서 actor를 선택하고 동일한 task, seed, canvas, action schema로 세션을 실행합니다.

## 실행

```bash
npm install
cp .env.example .env.local
npm run dev
```

Google Speech-to-Text를 사용하려면 `GOOGLE_APPLICATION_CREDENTIALS` 또는 `.env.local`의 관련 값을 설정해야 합니다. 인증이 없어도 drawing, raw audio 녹음과 JSON export는 사용할 수 있으며 STT 결과만 실패 상태로 기록됩니다.

## Human-only 배포

Prolific 또는 참가자 대상 배포에서는 기본적으로 Agent mode를 숨기고 API도 닫습니다.

```env
VITE_ENABLE_AGENT_MODE=false
ENABLE_AGENT_API=false
```

이 상태에서는 첫 화면이 Human session setup으로 바로 열리며 `/api/agent-decision`도 403을 반환합니다. Agent 연구/디버깅을 다시 켤 때만 두 값을 모두 `true`로 설정하고 `OPENAI_API_KEY`를 제공합니다.

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
- 연속 음성 chunk, STT 결과 및 오류
- mouse, touch, pen pointer modality
- 최종 Excalidraw scene과 PNG data URL

세션 종료 후 JSON과 raw audio를 각각 내려받습니다. JSON 구조는 [`docs/data-format.md`](docs/data-format.md)에 설명되어 있습니다.

Human 세션의 think-aloud는 음성 녹음만 제공합니다. 녹음은 선택 사항이며 drawing action 수집과 독립적으로 시작하거나 중단할 수 있습니다.

## Agent 실행

Agent 세션은 Participant ID를 요구하지 않습니다. 기본 시간 예산은 5분이며 최대 turn 수를 사용하지 않습니다. 각 판단은 필요한 수의 tool call을 한 batch로 반환할 수 있고, 각 call과 artifact 변화는 실행 즉시 화면과 export에 기록됩니다.

남은 시간이 30초가 되기 전에는 Agent의 조기 종료를 허용하지 않습니다. 마지막 30초에는 새로운 확장보다 현재 artifact의 검토, 정리, 최종 수정을 우선하고 `finish`를 결정합니다. 5분이 지나면 진행 중인 요청을 중단하고 현재 canvas를 최종 artifact로 확정합니다.

## Agent API

세션이 열린 브라우저에서 `window.simevalAgentApi`를 사용할 수 있습니다.

```js
const agent = window.simevalAgentApi;
agent.addShape("rectangle", 100, 100, 240, 120, { backgroundColor: "#ffd43b" });
agent.addLine([[0, 0], [30, 20], [80, 10]], { freeDraw: true, strokeColor: "#1971c2" });
agent.addText(130, 130, "concept");
agent.submitThinkAloud("I am connecting the two visual ideas.");
```

Agent mutation도 인간 action과 같은 snapshot timeline에 기록되지만 `actorType: "agent"`로 분리됩니다. 자동 실행과 외부 API 호출 모두 같은 instrumented tool layer를 사용합니다.

## 태블릿

UI는 touch/pen 입력을 막지 않으며 화면 폭에 따라 task panel을 canvas 위쪽으로 이동합니다. 세션 setup에서 주 입력 장치를 기록하고 실제 pointer event의 `pointerType`도 별도로 저장합니다.
