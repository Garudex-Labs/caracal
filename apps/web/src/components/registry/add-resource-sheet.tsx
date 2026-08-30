// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Single-entry creation drawer: pick a resource type, fill its fields, create -
// no intermediate page. Component types reuse the canonical SubmitComponentDialog
// form in sheet mode (same validation, drafts, and visibility); agents get a
// compact quick-create that mirrors the builder's payload and lands on the
// created change request.

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PickerSelect } from "@/components/ui/picker-select";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { SubmitComponentDialog } from "@/components/registry/submit-component-dialog";
import { useComponentSaveDraft, useComponentSubmit, useWhoami } from "@/hooks/use-api";
import { registry, type RegistryType } from "@/lib/api";
import { isValidAgentName, normalizeAgentName } from "@/lib/registry-name";

const RESOURCE_TYPE_OPTIONS: { value: string; label: string }[] = [
	{ value: "agents", label: "Agent" },
	{ value: "mcps", label: "MCP server" },
	{ value: "skills", label: "Skill" },
	{ value: "hooks", label: "Hook" },
	{ value: "prompts", label: "Prompt" },
	{ value: "sandboxes", label: "Sandbox" },
];

const AGENT_CATEGORIES = [
	"Code Review",
	"Testing",
	"Documentation",
	"DevOps",
	"Security",
	"Data",
	"Incident Response",
	"Deployment",
	"Cost Optimization",
	"Other",
];

const AGENT_NAME_ERROR = "Must start with a letter/digit, only lowercase letters, digits, hyphens, underscores.";

function TypeSelector({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	return (
		<div className="space-y-1.5 border-b border-border pb-3">
			<Label htmlFor="add-resource-type">Resource type</Label>
			<Select value={value || undefined} onValueChange={onChange}>
				<SelectTrigger id="add-resource-type" className="h-8 text-xs" aria-label="Resource type">
					<SelectValue placeholder="Select a resource type…" />
				</SelectTrigger>
				<SelectContent>
					{RESOURCE_TYPE_OPTIONS.map((option) => (
						<SelectItem key={option.value} value={option.value} className="text-xs">
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function AgentQuickCreate({
	open,
	onOpenChange,
	typeSelector,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	typeSelector: React.ReactNode;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: whoami } = useWhoami();

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [prompt, setPrompt] = useState("");
	const [category, setCategory] = useState("");
	const [version, setVersion] = useState("1.0.0");
	const [visibility, setVisibility] = useState<"public" | "team" | "private">("public");
	const [pending, setPending] = useState(false);

	const visibilityOptions = [
		{ value: "public", label: "Public" },
		{ value: "team", label: "Project members" },
		{ value: "private", label: "Private (only you)" },
	];

	async function handleCreate() {
		if (!name.trim()) {
			toast.error("Agent name is required");
			return;
		}
		if (!isValidAgentName(name)) {
			toast.error(`Invalid agent name. ${AGENT_NAME_ERROR}`);
			return;
		}
		if (!description.trim()) {
			toast.error("A description is required.");
			return;
		}
		if (!prompt.trim()) {
			toast.error("An agent prompt is required.");
			return;
		}
		setPending(true);
		try {
			// Mirrors the builder's buildRequestBody for a component-less agent.
			const body: Record<string, unknown> = {
				name: normalizeAgentName(name),
				version: version.trim() || "1.0.0",
				description: description.trim(),
				category: category || undefined,
				owner: whoami?.username || whoami?.email || "unknown",
				prompt: prompt.trim(),
				model_name: "",
				models_by_harness: {},
				components: [],
				visibility,
			};
			const created = await registry.create("agents", body);
			toast.success("Agent submitted for review.");
			queryClient.invalidateQueries({ queryKey: ["registry", "agents"] });
			queryClient.invalidateQueries({ queryKey: ["resources"] });
			onOpenChange(false);
			navigate({ to: "/agents/$agentId", params: { agentId: created.id }, search: { view: "review" } });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to create agent");
		} finally {
			setPending(false);
		}
	}

	return (
		<Sheet modal={false} open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>Submit Agent</SheetTitle>
				</SheetHeader>
				{typeSelector}
				<div className="space-y-4 pt-2">
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label htmlFor="agent-name">Name *</Label>
							<Input
								id="agent-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="my-agent"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="agent-version">Version</Label>
							<Input
								id="agent-version"
								value={version}
								onChange={(e) => setVersion(e.target.value)}
								placeholder="1.0.0"
							/>
						</div>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="agent-desc">Description *</Label>
						<Textarea
							id="agent-desc"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="What does this agent do?"
							rows={2}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="agent-prompt">Agent prompt *</Label>
						<Textarea
							id="agent-prompt"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							placeholder="System prompt that defines the agent's behavior…"
							rows={6}
							className="font-mono text-xs"
						/>
					</div>
					<div className="space-y-1.5">
						<Label>Category</Label>
						<PickerSelect
							value={category}
							onValueChange={setCategory}
							options={[
								{ value: "", label: "None" },
								...AGENT_CATEGORIES.map((entry) => ({ value: entry, label: entry })),
							]}
							ariaLabel="Agent category"
						/>
					</div>
					<div className="space-y-1.5">
						<Label>Visibility</Label>
						<PickerSelect
							value={visibility}
							onValueChange={(value) => setVisibility(value as "public" | "team" | "private")}
							options={visibilityOptions}
							ariaLabel="Visibility"
						/>
					</div>
					<div className="flex justify-end gap-2 border-t border-border pt-3">
						<Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
							Cancel
						</Button>
						<Button onClick={handleCreate} disabled={pending || !name}>
							{pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
							Submit for Review
						</Button>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}

export function AddResourceSheet({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	// No preselection: the drawer opens with only the type selector.
	const [selectedType, setSelectedType] = useState("");
	const componentType = (selectedType && selectedType !== "agents" ? selectedType : "mcps") as RegistryType;
	const submitMutation = useComponentSubmit(componentType);
	const saveDraftMutation = useComponentSaveDraft(componentType);

	const close = () => onOpenChange(false);
	const refreshResources = () => queryClient.invalidateQueries({ queryKey: ["resources"] });
	const typeSelector = <TypeSelector value={selectedType} onChange={setSelectedType} />;

	if (!selectedType) {
		return (
			<Sheet modal={false} open={open} onOpenChange={onOpenChange}>
				<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
					<SheetHeader>
						<SheetTitle>Add resource</SheetTitle>
					</SheetHeader>
					{typeSelector}
					<p className="pt-2 text-xs text-muted-foreground">
						Select a resource type to see its creation fields.
					</p>
				</SheetContent>
			</Sheet>
		);
	}

	if (selectedType === "agents") {
		return <AgentQuickCreate open={open} onOpenChange={onOpenChange} typeSelector={typeSelector} />;
	}

	return (
		<SubmitComponentDialog
			container="sheet"
			headerExtra={typeSelector}
			open={open}
			onOpenChange={onOpenChange}
			type={componentType}
			onSubmit={(body) => {
				submitMutation.mutate(body, {
					onSuccess: () => {
						refreshResources();
						close();
					},
				});
			}}
			onSaveDraft={(body) => {
				saveDraftMutation.mutate(body, {
					onSuccess: () => {
						refreshResources();
						close();
					},
				});
			}}
			isSubmitting={submitMutation.isPending}
			isSavingDraft={saveDraftMutation.isPending}
		/>
	);
}
