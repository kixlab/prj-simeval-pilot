export type TaskType =
  | "free_creation"
  | "open_ended_interpretation"
  | "conceptual_synthesis"
  | "adaptive_reframing";

export type TaskPhase = "single_phase" | "phase_1" | "phase_2";

export type TaskDefinition = {
  type: TaskType;
  number: number;
  title: string;
  construct: string;
  instruction: string;
  seeds: Array<{ id: string; label: string }>;
};

export const taskDefinitions: TaskDefinition[] = [
  {
    type: "free_creation",
    number: 1,
    title: "Free Creation",
    construct: "Baseline creative generation",
    instruction:
      "현실에는 아직 존재하지 않지만 사람들이 실제로 사용할 수 있는 새로운 물체, 장치 또는 공간을 그려주세요. 무엇을 만들지, 어떤 용도로 사용하는지는 자유롭게 결정하세요.",
    seeds: [
      { id: "daily_object", label: "사람들이 일상에서 사용할 수 있는 새로운 물체" },
      { id: "shared_space", label: "여러 사람이 함께 사용할 수 있는 새로운 공간" },
      { id: "mobility_device", label: "이동을 돕는 새로운 장치" },
      { id: "emotion_tool", label: "감정을 표현하거나 전달하는 새로운 도구" },
      { id: "nature_structure", label: "자연환경과 상호작용하는 새로운 구조물" }
    ]
  },
  {
    type: "open_ended_interpretation",
    number: 2,
    title: "Open-ended Interpretation",
    construct: "Problem construction and framing",
    instruction:
      "캔버스에 주어진 모든 시각적 요소를 그림의 의미 있는 일부로 사용하여 하나의 독창적이고 일관된 장면으로 완성하세요. 요소의 의미와 전체 장면의 주제는 자유롭게 결정할 수 있습니다.",
    seeds: [
      { id: "semicircle_scene", label: "큰 반원, 작은 사각형, 물결선, 짧은 화살표" },
      { id: "ladder_scene", label: "끊긴 사다리, 구름 같은 형태, 세 개의 점" }
    ]
  },
  {
    type: "conceptual_synthesis",
    number: 3,
    title: "Conceptual Synthesis",
    construct: "Conceptual combination and synthesis",
    instruction:
      "다음 두 개념을 하나의 그림 아이디어로 통합하세요. 두 요소를 따로 배치하는 데 그치지 말고, 하나가 다른 하나의 기능이나 의미를 변화시키도록 표현하세요.",
    seeds: [
      { id: "umbrella_memory", label: "우산 + 기억" },
      { id: "garden_clock", label: "정원 + 시계" },
      { id: "library_creature", label: "도서관 + 생명체" },
      { id: "shadow_instrument", label: "그림자 + 악기" },
      { id: "map_emotion", label: "지도 + 감정" },
      { id: "bridge_dialogue", label: "다리 + 대화" }
    ]
  },
  {
    type: "adaptive_reframing",
    number: 4,
    title: "Adaptive Reframing",
    construct: "Representational change and constraint relaxation",
    instruction: "사람들이 사용할 수 있는 새로운 대상을 디자인하세요.",
    seeds: [
      { id: "public_space", label: "공공 공간" },
      { id: "mobility_device", label: "이동 장치" },
      { id: "memory_storage", label: "기억 보관장치" },
      { id: "safe_home", label: "안전한 집" }
    ]
  }
];

export function taskByType(type: TaskType) {
  return taskDefinitions.find(task => task.type === type)!;
}

export function instructionForTask(type: TaskType, seedLabel: string, phase: TaskPhase) {
  const task = taskByType(type);
  if (type === "free_creation") {
    return `${task.instruction}\n\n이번 세션의 출발 조건: ${seedLabel}`;
  }
  if (type === "open_ended_interpretation") {
    return `${task.instruction}\n\n이번 세션에 주어진 시각적 요소: ${seedLabel}`;
  }
  if (type === "conceptual_synthesis") return `${task.instruction}\n\n개념 쌍: ${seedLabel}`;
  if (type === "adaptive_reframing") {
    if (phase === "phase_2") {
      return `새로운 정보를 알려드립니다. 이 ${seedLabel}의 사용자는 인간이 아니라 빛을 피해야 하는 생명체입니다. 기존 그림을 새로운 조건에 맞게 수정하세요.`;
    }
    return `사람들이 휴식을 취하거나 생활에 활용할 수 있는 새로운 ${seedLabel}를 디자인하세요.`;
  }
  return task.instruction;
}

export function chooseSeed(type: TaskType, requestedId: string, randomize: boolean) {
  const seeds = taskByType(type).seeds;
  if (randomize) return seeds[Math.floor(Math.random() * seeds.length)];
  return seeds.find(seed => seed.id === requestedId) ?? seeds[0];
}
