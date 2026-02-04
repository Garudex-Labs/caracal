"""
Caracal Flow Onboarding Screen.

First-run setup wizard with:
- Step 1: Configuration path selection
- Step 2: Database setup (optional)
- Step 3: First agent registration
- Step 4: First policy creation
- Skip options with actionable to-dos
"""

from pathlib import Path
from typing import Any, Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.components.wizard import Wizard, WizardStep
from caracal.flow.state import FlowState, StatePersistence, RecentAction
from caracal.flow.theme import Colors, Icons


def _step_config(wizard: Wizard) -> Any:
    """Step 1: Configuration setup."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    default_path = Path.home() / ".caracal"
    
    console.print(f"  [{Colors.NEUTRAL}]Caracal stores its configuration and data files in a directory.")
    console.print(f"  [{Colors.DIM}]Default location: {default_path}[/]")
    console.print()
    
    # Check if already initialized
    if default_path.exists() and (default_path / "config.yaml").exists():
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Configuration found at {default_path}[/]")
        console.print()
        
        use_existing = prompt.confirm(
            "Use existing configuration?",
            default=True,
        )
        
        if use_existing:
            wizard.context["config_path"] = str(default_path)
            return str(default_path)
    
    # Ask for path
    console.print()
    use_default = prompt.confirm(
        f"Use default location ({default_path})?",
        default=True,
    )
    
    if use_default:
        config_path = default_path
    else:
        path_str = prompt.text(
            "Enter configuration directory path",
            default=str(default_path),
        )
        config_path = Path(path_str).expanduser()
    
    # Initialize directory structure
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Initializing configuration...[/]")
    
    try:
        _initialize_caracal_dir(config_path)
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Configuration initialized at {config_path}[/]")
        wizard.context["config_path"] = str(config_path)
        return str(config_path)
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to initialize: {e}[/]")
        raise


def _initialize_caracal_dir(path: Path) -> None:
    """Initialize Caracal directory structure."""
    # Create directories
    path.mkdir(parents=True, exist_ok=True)
    (path / "backups").mkdir(exist_ok=True)
    
    # Create default config if needed
    config_path = path / "config.yaml"
    if not config_path.exists():
        default_config = f"""# Caracal Core Configuration

storage:
  agent_registry: {path}/agents.json
  policy_store: {path}/policies.json
  ledger: {path}/ledger.jsonl
  pricebook: {path}/pricebook.csv
  backup_dir: {path}/backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily
  default_budget: 100.00

logging:
  level: INFO
  file: {path}/caracal.log
"""
        config_path.write_text(default_config)
    
    # Create empty data files if needed
    agents_path = path / "agents.json"
    if not agents_path.exists():
        agents_path.write_text("[]")
    
    policies_path = path / "policies.json"
    if not policies_path.exists():
        policies_path.write_text("[]")
    
    ledger_path = path / "ledger.jsonl"
    if not ledger_path.exists():
        ledger_path.write_text("")
    
    pricebook_path = path / "pricebook.csv"
    if not pricebook_path.exists():
        sample_pricebook = """resource_type,price_per_unit,currency,updated_at
openai.gpt4.input_tokens,0.000030,USD,2024-01-15T10:00:00Z
openai.gpt4.output_tokens,0.000060,USD,2024-01-15T10:00:00Z
openai.gpt35.input_tokens,0.000001,USD,2024-01-15T10:00:00Z
openai.gpt35.output_tokens,0.000002,USD,2024-01-15T10:00:00Z
anthropic.claude3.input_tokens,0.000015,USD,2024-01-15T10:00:00Z
anthropic.claude3.output_tokens,0.000075,USD,2024-01-15T10:00:00Z
"""
        pricebook_path.write_text(sample_pricebook)


def _step_database(wizard: Wizard) -> Any:
    """Step 2: Database setup (optional)."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    console.print(f"  [{Colors.NEUTRAL}]Caracal can use either file-based storage or PostgreSQL.")
    console.print(f"  [{Colors.DIM}]File-based storage is simpler and works out of the box.[/]")
    console.print(f"  [{Colors.DIM}]PostgreSQL is recommended for production use.[/]")
    console.print()
    
    use_postgres = prompt.confirm(
        "Configure PostgreSQL database?",
        default=False,
    )
    
    if not use_postgres:
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Using file-based storage[/]")
        wizard.context["database"] = "file"
        return "file"
    
    # PostgreSQL configuration
    console.print()
    console.print(f"  [{Colors.INFO}]Enter PostgreSQL connection details:[/]")
    console.print()
    
    host = prompt.text("Host", default="localhost")
    port = prompt.number("Port", default=5432, min_value=1, max_value=65535)
    database = prompt.text("Database name", default="caracal")
    username = prompt.text("Username", default="caracal")
    
    # Password is sensitive, use secure input with toggle
    password = prompt.password("Password")
    
    wizard.context["database"] = {
        "type": "postgresql",
        "host": host,
        "port": int(port),
        "database": database,
        "username": username,
        "password": password,
    }
    
    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Database configured[/]")
    console.print(f"  [{Colors.DIM}]Note: Update your config.yaml to use these settings[/]")
    
    return wizard.context["database"]


def _step_agent(wizard: Wizard) -> Any:
    """Step 3: Register first agent."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    console.print(f"  [{Colors.NEUTRAL}]Let's register your first AI agent.")
    console.print(f"  [{Colors.DIM}]Agents are identities that can spend budget.[/]")
    console.print()
    
    name = prompt.text(
        "Agent name",
        default="my-first-agent",
    )
    
    owner = prompt.text(
        "Owner email",
        default="admin@example.com",
    )
    
    # Store for later
    wizard.context["first_agent"] = {
        "name": name,
        "owner": owner,
    }
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Agent will be registered after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Name: {name}[/]")
    console.print(f"  [{Colors.DIM}]Owner: {owner}[/]")
    
    return wizard.context["first_agent"]


def _step_policy(wizard: Wizard) -> Any:
    """Step 4: Create first policy."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    agent_info = wizard.context.get("first_agent", {})
    agent_name = agent_info.get("name", "the agent")
    
    console.print(f"  [{Colors.NEUTRAL}]Now let's set a budget limit for {agent_name}.")
    console.print(f"  [{Colors.DIM}]Policies define spending limits within time windows.[/]")
    console.print()
    
    budget = prompt.number(
        "Daily budget limit (USD)",
        default=100.0,
        min_value=0.01,
    )
    
    wizard.context["first_policy"] = {
        "limit": budget,
        "currency": "USD",
        "time_window": "daily",
    }
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Policy will be created after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Limit: ${budget:.2f}/day[/]")
    
    return wizard.context["first_policy"]


def run_onboarding(
    console: Optional[Console] = None,
    state: Optional[FlowState] = None,
) -> dict[str, Any]:
    """
    Run the onboarding wizard.
    
    Args:
        console: Rich console
        state: Application state
    
    Returns:
        Dictionary of collected information
    """
    console = console or Console()
    
    # Check if already completed
    if state and state.onboarding.completed:
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Onboarding already completed[/]")
        rerun = FlowPrompt(console).confirm("Run onboarding again?", default=False)
        if not rerun:
            return {}
    
    # Define wizard steps
    steps = [
        WizardStep(
            key="config",
            title="Configuration Setup",
            description="Set up Caracal's configuration directory and files",
            action=_step_config,
            skippable=False,
        ),
        WizardStep(
            key="database",
            title="Database Setup",
            description="Configure database connection (optional)",
            action=_step_database,
            skippable=True,
            skip_message="Using default file-based storage",
        ),
        WizardStep(
            key="agent",
            title="Register First Agent",
            description="Create your first AI agent identity",
            action=_step_agent,
            skippable=True,
            skip_message="You can register agents later from the main menu",
        ),
        WizardStep(
            key="policy",
            title="Create First Policy",
            description="Set up a budget policy for your agent",
            action=_step_policy,
            skippable=True,
            skip_message="You can create policies later from the main menu",
        ),
    ]
    
    # Run wizard
    wizard = Wizard(
        title="Welcome to Caracal Flow",
        steps=steps,
        console=console,
    )
    
    results = wizard.run()
    
    # Show summary
    wizard.show_summary()
    
    # Persist changes
    try:
        from decimal import Decimal
        from caracal.config import load_config
        from caracal.core.identity import AgentRegistry
        from caracal.core.policy import PolicyStore
        
        # Load fresh config (in case it was just initialized)
        config = load_config()
        
        # Initialize registry
        registry = AgentRegistry(config.storage.agent_registry)
        
        # Handle Agent Registration
        agent_data = results.get("agent")
        if agent_data:
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Finalizing setup...[/]")
            
            # Clear existing/dummy agents as requested
            registry._agents = {}
            registry._names = {}
            registry._persist()
            
            try:
                agent = registry.register_agent(
                    name=agent_data["name"],
                    owner=agent_data["owner"],
                )
                results["agent_id"] = agent.agent_id
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Agent registered successfully.[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to register agent: {e}[/]")
        
        # Handle Policy Creation
        policy_data = results.get("policy")
        if policy_data and results.get("agent_id"):
            try:
                # Initialize PolicyStore with agent registry for validation
                policy_store = PolicyStore(
                    policy_path=config.storage.policy_store,
                    agent_registry=registry
                )
                
                # Clear existing policies to start fresh (matching user intent)
                policy_store._policies = {}
                policy_store._agent_policies = {}
                policy_store._persist()
                
                policy_store.create_policy(
                    agent_id=results["agent_id"],
                    limit_amount=Decimal(str(policy_data["limit"])),
                    time_window=policy_data["time_window"],
                    currency=policy_data["currency"]
                )
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Policy created successfully.[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to create policy: {e}[/]")
                
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error saving configuration: {e}[/]")

    # Update state
    if state:
        state.onboarding.mark_complete()
        for step in steps:
            if step.status.value == "completed":
                state.onboarding.mark_step_complete(step.key)
            elif step.status.value == "skipped":
                state.onboarding.mark_step_skipped(step.key)
        
        # Save state
        persistence = StatePersistence()
        persistence.save(state)
    
    # Show next steps
    _show_next_steps(console, results, wizard.context)
    
    return results


def _show_next_steps(console: Console, results: dict, context: dict) -> None:
    """Show actionable next steps after onboarding."""
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Next Steps:[/]")
    console.print()
    
    todos = []
    
    # Check what was skipped
    if results.get("agent") is None:
        todos.append(("Register an agent", "caracal agent register --name my-agent --owner user@example.com"))
    else:
        agent = context.get("first_agent", {})
        todos.append((
            f"Complete agent registration",
            f"caracal agent register --name {agent.get('name', 'my-agent')} --owner {agent.get('owner', 'user@example.com')}"
        ))
    
    if results.get("policy") is None:
        todos.append(("Create a budget policy", "caracal policy create --agent-id <uuid> --limit 100.00"))
    
    if results.get("database") == "file":
        todos.append(("Consider PostgreSQL for production", "Set database.type: postgresql in config.yaml"))
    
    # Always suggest viewing the ledger
    todos.append(("Explore your ledger", "caracal ledger query"))
    
    for i, (title, cmd) in enumerate(todos, 1):
        console.print(f"  [{Colors.NEUTRAL}]{i}. {title}[/]")
        console.print(f"     [{Colors.DIM}]{cmd}[/]")
        console.print()
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue to the main menu...[/]")
    input()
