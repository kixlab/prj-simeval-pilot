# SimEval Drawing Pilot: Agent 성능 개선 토의용 Context

이 문서는 현재 구현을 기준으로 Agent의 drawing 성능과 process logging 설계를 검토하기 위한 토의 자료다. Web GPT에 문서 전체를 전달한 뒤, 마지막의 토의 요청을 중심으로 논의하면 된다.

## 1. 연구 목적

이 프로젝트는 Excalidraw 기반 창의적 drawing task에서 Human과 AI Agent의 최종 산출물만 비교하는 것이 아니라, 산출물이 만들어지는 과정도 함께 수집·분석하기 위한 pilot system이다.

현재 관심사는 대략 다음과 같다.

- 같은 task, seed, canvas 환경에서 Human과 Agent가 어떤 과정을 거쳐 결과물을 만드는가?
- 생성, 수정, 이동, 삭제, 재구성 같은 artifact 변화는 어떤 시간적 구조를 가지는가?
- Human의 think-aloud와 Agent가 외부에 보고한 판단 요약을 artifact 변화와 어떻게 연결할 수 있는가?
- 후처리에서 linked action, Move, Cognitive Decision Step과 같은 상위 process unit을 어떻게 추출할 수 있는가?
- Agent 성능을 높이되, 비교 가능한 과정 로그와 연구 타당성을 훼손하지 않으려면 무엇을 고정하고 무엇을 개선해야 하는가?

따라서 목표는 단순한 “예쁜 그림 생성기”가 아니다. 충분히 유능한 Agent가 관찰, 아이디어 형성, 실행, 검사, 수정하는 과정을 재현 가능하고 분석 가능한 형태로 남기는 것이 중요하다.

## 2. Task 구성

Human과 Agent는 동일한 네 종류의 task를 수행한다.

1. **Free Creation**: 현실에는 아직 없지만 실제로 사용할 수 있는 새로운 물체, 장치 또는 공간 생성
2. **Open-ended Interpretation**: 주어진 모든 seed element를 활용해 하나의 독창적이고 일관된 장면 완성
3. **Conceptual Synthesis**: 두 개념을 단순 병치하지 않고, 하나가 다른 하나의 기능이나 의미를 바꾸도록 통합
4. **Adaptive Reframing**: Phase 1의 디자인을 Phase 2에서 공개되는 새로운 사용자 조건에 맞게 수정

Seed는 manual 또는 random assignment를 지원한다. Open-ended Interpretation에는 실제 Excalidraw seed element가 초기 canvas에 배치된다. Adaptive Reframing은 실행 도중 instruction이 바뀐다.

## 3. 현재 Agent 실행 환경

- Frontend: React 18 + Vite 4 + Excalidraw 0.17
- Agent API: Vite middleware의 `POST /api/agent-decision`
- LLM API: OpenAI Responses API
- 현재 `.env.local` 모델: `gpt-5.5`
- Agent mode와 Agent API: 현재 local 설정에서 모두 enabled
- 시간 예산: UI에서 1~30분, 기본 5분
- finalization window: 마지막 30초
- turn 수 또는 element 수의 고정 상한은 없음
- 한 decision에서 여러 tool call을 순서대로 반환 가능
- Responses API에는 strict JSON schema를 사용
- 현재 reasoning effort, temperature, service tier 등 별도 추론 설정은 전달하지 않음

Agent는 남은 시간이 30초보다 많을 때 `finish`를 요청해도 종료되지 않는다. 마지막 30초에만 `finish`가 수용되며, 시간이 끝나면 현재 canvas가 최종 결과가 된다.

## 4. 현재 observation → decision → action loop

각 decision cycle은 다음 순서로 동작한다.

1. `get_scene_summary`로 현재 scene의 compact summary를 얻는다.
2. 현재 full scene을 PNG data URL로 export한다.
3. 다음 정보를 `/api/agent-decision`에 보낸다.
   - 현재 task instruction
   - elapsed/remaining time
   - finalization window 여부
   - scene summary
   - 최근 Agent trajectory 12개
   - 현재 screenshot
4. 모델은 structured decision 하나를 반환한다.
   - `status`: continue 또는 finish
   - `agentThought`
   - `decisionRationale`
   - `semanticLabel`
   - `finishReason`
   - `toolCalls[]`
5. 반환된 tool call을 클라이언트에서 순서대로 동기 실행한다.
6. 각 tool call의 input/output과 artifact 변화를 기록한다.
7. 모든 call이 끝난 뒤 다음 decision cycle에서 다시 screenshot과 summary를 만든다.

중요한 현재 특성:

- 같은 decision batch 내부에서는 tool call 사이에 모델이 새 화면을 보거나 재계획하지 않는다.
- tool 실패가 발생해도 남은 batch call은 계속 실행될 수 있다.
- tool 실행 결과를 바탕으로 즉시 자동 repair decision을 만드는 별도 controller는 없다.
- 매 decision이 독립적인 Responses API 요청이다. Responses API의 conversation state 또는 previous response ID는 사용하지 않는다.
- recent trajectory는 최근 12개 entry만 전달한다. decision과 tool call이 같은 배열에 섞이므로 실제로 보존되는 decision 수는 batch 크기에 따라 달라진다.
- 빈 canvas에서는 screenshot을 보내지 않고 scene summary만 보낸다.
- non-empty scene에서는 매 cycle PNG를 다시 생성한다.

## 5. 현재 system prompt의 핵심 정책

현재 prompt는 Agent를 timed research session의 reflective visual designer로 정의한다.

- 한 decision에 필요한 만큼 tool call을 포함할 수 있다.
- 고정 phase pipeline, 고정 turn 수, 인위적인 tool/element 상한을 두지 않는다.
- 생성 후 검사, 수정, 단순화, 교체, 재배치, refinement를 허용한다.
- local revision에는 full-scene replacement를 피하도록 한다.
- shape 내부 text에는 `labelText`, `labelFontSize`를 권장한다.
- element에 task-specific `semanticRole`을 부여하도록 한다.
- 수정·이동·삭제에는 scene summary의 정확한 element ID를 사용하도록 한다.
- finalization window 전에는 finish하지 않는다.
- 할 일이 없으면 의미 없는 작업을 만들지 말고 empty `toolCalls`로 continue한다.
- `agentThought`와 `decisionRationale`은 private chain-of-thought가 아니라 관찰 가능한 짧은 판단 요약이다.

현재 prompt에는 창의성 평가 rubric, task별 품질 기준, composition checklist, explicit self-critique rubric, novelty/utility/coherence 간 trade-off, 최소 기능 설명 규칙 등이 구체적으로 들어 있지 않다.

## 6. Agent가 사용할 수 있는 tool

### Observation

- `get_scene`
- `get_scene_summary`

실제로 두 tool 모두 현재 구현에서는 거의 같은 `SceneSummary`를 반환한다. screenshot은 tool이 아니라 controller가 매 decision 전에 자동 생성한다.

### Scene 생성 및 편집

- `clear_canvas`
- `create_scene`
- `add_elements`
- `update_elements`
- `delete_elements`
- `move_elements`
- `rotate_elements`
- `bind_elements`
- `replace_scene`
- `sketch_path`
- `free_draw`

지원하는 기본 element type은 rectangle, ellipse, diamond, text, arrow, line이다. 이미지 생성·삽입, icon library, grouping command, z-order command, duplication, alignment/distribution, crop, zoom control은 별도 tool로 제공되지 않는다.

### Tool safeguard

- non-empty scene에서 `create_scene(replace=true)`는 차단된다.
- `replace_scene`은 reason에 full/redesign/reset/replace와 같은 명시적 표현이 있어야 한다.
- fixed constraint element는 update/delete/move할 수 없다.
- 존재하지 않는 ID의 update/delete/move는 실패한다.
- bound label이 없는 element에 label update를 요청하면 실패한다.
- sketch/free-draw path는 point 구조를 검사한다.
- text는 자동 wrap 및 크기 보정을 거친다.
- canvas bounds와 text overflow warning을 scene summary에 포함한다.

## 7. Structured output의 제약

strict schema 때문에 모든 tool call은 사용하지 않는 필드까지 전부 반환해야 한다.

예를 들어 단순한 `get_scene_summary` call도 다음과 같은 중립값을 모두 포함해야 한다.

- `description`, `reason`
- `replace`, `fitToContent`
- `elements`, `updates`, `elementIds`, `moves`, `paths`

Element 역시 type에 관계없이 x, y, width, height, text, fontSize, style, label, points, semanticRole, groupId 등을 모두 반환한다. 이 방식은 parsing 안정성은 높지만 다음 가능성이 있다.

- 응답 token과 생성 부담 증가
- 사용하지 않는 neutral field에서 오류 가능성 증가
- tool별 계약이 모델 입장에서 불명확해짐
- 복잡한 batch를 만들수록 schema 작성 비용 증가

## 8. 현재 Agent logging

Agent 관련 export는 크게 두 층이다.

### `agentTrajectory`

Agent controller의 판단과 실행을 시간순으로 기록한다.

- `kind`: decision, tool_call, error, finish
- elapsed/remaining time
- decision number
- 사용 model
- agentThought, decisionRationale, semanticLabel
- toolName, toolInput, toolOutput
- success와 message

하나의 decision에 여러 tool call이 있으면 같은 decision number를 공유한다.

### `actions`

실제 scene을 바꾸는 Agent tool만 Human과 공통인 artifact action 형식으로 기록한다.

- `actorType: agent`
- `actorMode: agent_reactive`
- `source: agent_tool`
- rawEventType에 tool name
- normalized action
- target object IDs
- before/after state digest
- artifact diff
- elementChanges
- action 전후 snapshot ID

Observation tool처럼 scene을 바꾸지 않는 call은 `actions`에는 없고 `agentTrajectory`에만 남는다.

## 9. 현재 Human logging과의 관계

Human side에는 현재 세 층의 데이터가 있다.

1. `elementMutations`: 매 Excalidraw `onChange` callback에서 기록한 element/property 수준 원본 변화
2. `actions`: 약 700ms idle 후 scene diff를 묶은 기존 high-level action
3. `thinkAloudChunks`: 약 10초 audio chunk와 STT transcript

Agent side에는 다음이 있다.

1. `agentTrajectory`: decision과 tool-call 기록
2. `actions`: mutating tool 기반 artifact 변화
3. Agent가 보고한 `agentThought`와 `decisionRationale`

중요한 비대칭:

- Human은 low-level 원본 mutation이 있으나 Agent는 tool command가 이미 구조화된 action이다.
- Human think-aloud는 자연스럽고 연속적인 음성이고, Agent rationale은 decision request마다 요구된 구조화된 self-report다.
- Agent의 한 decision은 여러 tool call을 포함할 수 있지만 Human의 Cognitive Decision Step은 아직 후처리로 추론해야 한다.
- Agent tool 실행은 거의 즉시 완료되므로 `actions.durationMs`가 Human manipulation duration과 직접 비교되기 어렵다.
- Agent는 매 cycle screenshot과 full symbolic summary를 동시에 받지만 Human은 화면을 자연스럽게 연속 관찰한다.

따라서 성능 개선과 별개로, 최종 분석에서는 공통 파생 단위를 정의할 필요가 있다. 후보는 다음과 같다.

- artifact-level atomic change
- linked action 또는 Move
- higher-level Cognitive Decision Step
- observation → intent → execution → evaluation/repair episode

## 10. 현재 구현에서 예상되는 Agent 성능 병목

아래는 코드 구조에서 직접 확인되는 잠재 병목이며, 실제 실험 데이터로 검증해야 한다.

### A. 관찰 비용과 정보 중복

매 cycle마다 full PNG와 상세 scene summary를 함께 보낸다. 작은 수정 뒤에도 전체 screenshot을 다시 export한다. latency와 input token/image 비용이 커지면 제한 시간 안의 decision/revision 횟수가 감소할 수 있다.

### B. Batch 내부 closed-loop 부재

여러 tool call을 한 번에 실행하면 latency는 줄지만, 앞선 call의 실제 결과를 확인하지 않은 채 뒤의 call을 실행한다. 새 element ID가 실행 시 생성되므로 같은 batch에서 방금 생성한 element를 정확한 ID로 다시 수정하기도 어렵다.

### C. Tool failure 이후 batch 지속

한 call의 실패가 후속 call의 전제를 무너뜨려도 batch 전체를 중단하거나 재계획하지 않는다. 로그에는 실패가 남지만 controller-level recovery policy는 없다.

### D. 장기 상태 요약 부족

최근 trajectory 12개만 제공되고, 장기 design intent, 이미 충족한 요구, 열린 문제, 보존해야 할 요소를 별도 working memory로 유지하지 않는다. 긴 session 또는 많은 tool call에서 초기 concept과 수정 이유가 사라질 수 있다.

### E. Task-specific critique 부족

system prompt는 일반적인 refinement를 요구하지만, 각 creativity construct를 평가하는 명시적 rubric은 없다. 예를 들어 Conceptual Synthesis에서 단순 병치인지 기능적 통합인지 체계적으로 검사하는 controller가 없다.

### F. Scene validation의 수동적 사용

summary에 bounds/overflow warning이 포함되지만 warning이 있으면 반드시 repair하도록 강제하지 않는다. requirement coverage나 composition quality를 판정하는 별도 deterministic completion gate도 현재 loop에 연결되어 있지 않다.

### G. 도구 표현력 제한

정렬, 분배, grouping, layer, connector binding, duplication 같은 편집 primitive가 부족하다. 모델이 좌표를 직접 계산하고 많은 element를 다시 명세해야 하므로 composition 정밀도가 낮아질 수 있다.

### H. 정량적 성능 telemetry 부족

현재 로그만으로도 일부 계산은 가능하지만 다음 값이 명시적으로 저장되지는 않는다.

- API request latency
- screenshot/export latency
- 모델 input/output token usage
- decision별 tool execution latency
- request retry count와 error category
- tool batch가 부분 실패했는지 여부
- observation 이후 첫 action까지 걸린 시간
- decision 전후 artifact quality delta

## 11. 개선 논의에서 구분해야 할 세 층

성능 개선안을 논의할 때 아래 세 층을 섞지 않는 것이 중요하다.

### 1) Model/prompt layer

- 모델 선택과 reasoning effort
- task-specific rubric
- self-critique 방식
- structured response 설계
- visual planning prompt

### 2) Agent controller layer

- observation cadence
- batch 크기와 중간 재관찰
- failure recovery
- working memory
- finalization policy
- time/latency-aware scheduling

### 3) Tool/environment layer

- tool granularity
- alignment/grouping/binding 등 편집 primitive
- stable element references
- validation and repair API
- screenshot/scene summary의 정보 구조

한 층의 문제를 다른 층의 prompt patch로만 해결하면 연구 protocol이 불안정해질 수 있다.

## 12. 연구 타당성을 위한 제약

개선안은 다음 조건을 고려해야 한다.

- Human과 Agent에 동일한 task instruction과 seed를 제공해야 한다.
- 최종 결과뿐 아니라 과정 로그를 보존해야 한다.
- Agent가 실제로 관찰하지 않은 정보를 사후적으로 trajectory에 추가하면 안 된다.
- `agentThought`는 private chain-of-thought가 아니라 외부에 보고 가능한 짧은 판단 요약이어야 한다.
- tool call과 실제 artifact diff의 연결을 유지해야 한다.
- 실험 조건 간 prompt, model, tool set, time budget, controller policy를 versioning해야 한다.
- 성능 향상을 위해 task 정답이나 seed별 template를 하드코딩하면 안 된다.
- Human의 raw mutation과 Agent tool trace를 동일한 데이터라고 가정하면 안 되며, 공통 상위 단위는 후처리 규칙으로 명시해야 한다.

## 13. 우선 검토할 개선 방향 후보

아직 채택된 결정이 아니라 토의를 위한 후보 목록이다.

1. **Telemetry first**: request/tool/screenshot latency와 token usage를 먼저 계측해 실제 병목 확인
2. **Failure-aware batching**: batch call 실패 시 후속 의존 call 중단 후 즉시 재관찰
3. **Adaptive observation**: 큰 scene 변경이나 실패 뒤에는 screenshot+summary, 단순 성공 뒤에는 summary 중심으로 관찰 비용 조절
4. **Explicit working memory**: concept, satisfied requirements, open issues, protected elements를 compact state로 유지
5. **Task-aware critic**: task construct별 rubric을 사용하되 seed별 정답은 제공하지 않는 critic 단계
6. **Deterministic validation gate**: bounds, overflow, missing seed preservation, empty text 등 기계적으로 검증 가능한 항목을 finish 전에 확인
7. **Tool contract simplification**: tool별 schema를 분리하거나 discriminated union을 사용해 unused field 제거
8. **Editing primitives 확장**: align, distribute, group, duplicate, reorder, bind connector 등 추가
9. **Stable references**: 같은 decision batch에서 새 element를 후속 call이 참조할 수 있는 client-generated alias 또는 symbolic handle
10. **Two-level logging**: raw tool calls를 유지하면서 여러 call을 하나의 design Move로 연결하는 explicit decision/move ID 추가
11. **Ablation-ready configuration**: model/prompt/controller/tool version을 export에 저장해 개선 효과를 분리 평가

## 14. Web GPT와 논의하고 싶은 질문

1. 현재 병목 중 Agent 결과 품질에 가장 큰 영향을 줄 가능성이 높은 것은 무엇인가?
2. 5분 time budget에서 한 decision의 batch 크기와 재관찰 빈도를 어떻게 설계하는 것이 좋은가?
3. task별 critic을 넣을 때 creativity를 지나치게 표준화하지 않으면서 coherence와 task fulfillment를 높이는 방법은 무엇인가?
4. screenshot과 symbolic scene summary를 매번 함께 보내는 현재 방식은 합리적인가? 더 효율적인 observation policy는 무엇인가?
5. Agent가 새로 생성한 element를 같은 batch에서 안정적으로 다시 참조하도록 tool protocol을 어떻게 바꾸는 것이 좋은가?
6. Agent tool failure를 controller가 어떤 단위로 감지하고 재계획해야 하는가?
7. Human과 Agent의 process를 비교할 공통 derived unit을 어떻게 정의하는 것이 타당한가?
8. Agent 성능 개선 실험에서 어떤 ablation matrix와 metric을 사용해야 개선 원인을 분리할 수 있는가?
9. 현재 `agentThought`/`decisionRationale` self-report를 연구 데이터로 사용할 때 어떤 해석상 주의가 필요한가?
10. 구현 비용 대비 효과를 고려했을 때 가장 먼저 적용할 3개 개선은 무엇인가?

## 15. Web GPT에 그대로 전달할 요청문

아래 요청을 이 문서와 함께 전달한다.

> 당신은 creative AI agent system과 HCI process evaluation을 함께 검토하는 연구 협력자다. 위 내용은 현재 실제 구현 상태다. 일반론적인 “prompt를 개선하라” 수준에서 끝내지 말고, Model/Prompt, Controller, Tool/Environment, Logging/Evaluation 층을 나누어 분석해 달라. 먼저 현재 구조에서 성능과 연구 타당성에 가장 큰 위험을 우선순위로 정리하고, 그다음 최소 변경안, 중간 규모 변경안, 장기 구조 변경안을 제안해 달라. 각 제안마다 기대 효과, 구현 난이도, latency/token 비용, process logging에 미치는 영향, Human-Agent 비교 타당성에 미치는 영향을 명시해 달라. 마지막에는 실제 구현 순서와 ablation plan을 제시해 달라. seed별 정답이나 task별 도형 template 하드코딩은 제안하지 말라.

## 16. 주요 코드 위치

- Agent loop 및 trajectory: `src/agent/timedAgent.ts`
- Structured output type/schema: `src/agent/timedAgentProtocol.ts`
- Excalidraw tool 구현: `src/agent/tools.ts`
- Browser-facing instrumented API: `src/agent/pilotAgentApi.ts`
- Tool 기반 artifact action logging: `src/logging/artifactActions.ts`
- App session orchestration/export: `src/App.tsx`
- Agent system prompt와 Responses API middleware: `vite.config.ts`
- Task/construct/instruction: `src/data/tasks.ts`
- Session export type: `src/data/sessionTypes.ts`
- Export format 설명: `docs/data-format.md`

