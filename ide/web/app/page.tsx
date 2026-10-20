"use client";

import { MotionConfig } from "motion/react";
import { Workbench } from "@/components/workbench/Workbench";

export default function Page() {
  return (
    <MotionConfig reducedMotion="user">
      <Workbench />
    </MotionConfig>
  );
}
