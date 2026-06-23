/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders an informative module surface for capabilities served outside the web control path.
*/
import type { ReactNode } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Card, SectionTitle, type Crumb } from "@/components/ui";

export function ModuleNotice({
  title,
  description,
  breadcrumbs,
  noticeTitle,
  children,
}: {
  title: string;
  description: string;
  breadcrumbs: Crumb[];
  noticeTitle: string;
  children: ReactNode;
}) {
  return (
    <ModulePage title={title} description={description} breadcrumbs={breadcrumbs}>
      <Card>
        <SectionTitle>{noticeTitle}</SectionTitle>
        <div className="mt-3 flex flex-col gap-3 text-sm text-muted-foreground">{children}</div>
      </Card>
    </ModulePage>
  );
}
