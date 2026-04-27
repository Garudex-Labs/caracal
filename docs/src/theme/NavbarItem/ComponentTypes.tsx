// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// This file registers custom documentation navbar item components.

import ComponentTypesOriginal from "@theme-original/NavbarItem/ComponentTypes";
import AiModeToggleNavbarItem from "./AiModeToggleNavbarItem";

import type { ComponentTypesObject } from "@theme/NavbarItem/ComponentTypes";

const ComponentTypes: ComponentTypesObject = {
  ...ComponentTypesOriginal,
  "custom-aiModeToggle": AiModeToggleNavbarItem,
};

export default ComponentTypes;
