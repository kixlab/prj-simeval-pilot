import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/types/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";

function seedData(seedId: string, seedKey: string) {
  return {
    seedElement: true,
    seedId,
    seedKey,
    semanticRole: `seed_${seedKey}`
  };
}

function semicircleScene(): ExcalidrawElementSkeleton[] {
  return [
    {
      type: "line",
      x: 360,
      y: 310,
      width: 360,
      height: 180,
      points: [[0, 180], [35, 95], [100, 35], [180, 0], [260, 35], [325, 95], [360, 180]],
      strokeWidth: 3,
      customData: seedData("semicircle_scene", "large_semicircle")
    },
    {
      type: "rectangle",
      x: 520,
      y: 260,
      width: 70,
      height: 55,
      backgroundColor: "#fff3bf",
      fillStyle: "solid",
      customData: seedData("semicircle_scene", "small_rectangle")
    },
    {
      type: "line",
      x: 820,
      y: 520,
      width: 270,
      height: 45,
      points: [[0, 20], [45, 0], [90, 35], [135, 8], [180, 40], [225, 12], [270, 28]],
      strokeColor: "#1971c2",
      strokeWidth: 3,
      customData: seedData("semicircle_scene", "distant_wave")
    },
    {
      type: "arrow",
      x: 700,
      y: 300,
      width: 120,
      height: 20,
      points: [[120, 20], [0, 0]],
      strokeColor: "#c92a2a",
      strokeWidth: 3,
      customData: seedData("semicircle_scene", "short_arrow")
    }
  ];
}

function ladderScene(): ExcalidrawElementSkeleton[] {
  const common = seedData("ladder_scene", "broken_ladder");
  return [
    { type: "line", x: 470, y: 120, width: 0, height: 250, points: [[0, 0], [0, 250]], strokeWidth: 3, customData: common },
    { type: "line", x: 610, y: 120, width: 0, height: 250, points: [[0, 0], [0, 250]], strokeWidth: 3, customData: common },
    ...[155, 210, 265, 320].map((y, index) => ({
      type: "line" as const,
      x: 470,
      y,
      width: 140,
      height: index === 0 ? 18 : 0,
      points: index === 0 ? [[0, 0], [55, 0], [85, 18], [140, 18]] : [[0, 0], [140, 0]],
      strokeWidth: 3,
      customData: common
    })),
    {
      type: "line",
      x: 390,
      y: 500,
      width: 330,
      height: 105,
      points: [[0, 75], [35, 35], [85, 42], [120, 0], [175, 30], [225, 12], [275, 55], [330, 75]],
      strokeColor: "#7950f2",
      strokeWidth: 3,
      customData: seedData("ladder_scene", "cloud_form")
    },
    ...[0, 1, 2].map(index => ({
      type: "ellipse" as const,
      x: 820 + index * 65,
      y: 290,
      width: 18,
      height: 18,
      backgroundColor: "#343a40",
      fillStyle: "solid" as const,
      customData: seedData("ladder_scene", `dot_${index + 1}`)
    }))
  ];
}

export function createSeedScene(seedId: string): ExcalidrawElement[] {
  const skeletons = seedId === "ladder_scene" ? ladderScene() : semicircleScene();
  return convertToExcalidrawElements(skeletons) as ExcalidrawElement[];
}
