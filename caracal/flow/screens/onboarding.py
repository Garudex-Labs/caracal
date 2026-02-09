"""
Caracal Flow Onboarding Screen.

First-run setup wizard with:
- Step 1: Configuration path selection
- Step 2: Database setup (optional)
- Step 3: First principal registration
- Step 4: First authority policy creation
- Step 5: Issue first mandate
- Step 6: Validate mandate demo
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
openai.gpt-5.2.input_tokens,1.75,USD,2024-01-15T10:00:00Z
openai.gpt-5.2.output_tokens,14.00,USD,2024-01-15T10:00:00Z
openai.gpt-5.2.cached_input_tokens,0.175,USD,2024-01-15T10:00:00Z
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


def _step_principal(wizard: Wizard) -> Any:
    """Step 3: Register first principal."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    console.print(f"  [{Colors.NEUTRAL}]Let's register your first principal.")
    console.print(f"  [{Colors.DIM}]Principals are identities that can hold authority.[/]")
    console.print()
    
    name = prompt.text(
        "Principal name",
        default="my-first-principal",
    )
    
    owner = prompt.text(
        "Owner email",
        default="admin@example.com",
    )
    
    principal_type = prompt.select(
        "Principal type",
        choices=["agent", "user", "service"],
        default="agent",
    )
    
    # Store for later
    wizard.context["first_principal"] = {
        "name": name,
        "owner": owner,
        "type": principal_type,
    }
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Principal will be registered after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Name: {name}[/]")
    console.print(f"  [{Colors.DIM}]Owner: {owner}[/]")
    console.print(f"  [{Colors.DIM}]Type: {principal_type}[/]")
    
    return wizard.context["first_principal"]


def _step_policy(wizard: Wizard) -> Any:
    """Step 4: Create first authority policy."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    principal_info = wizard.context.get("first_principal", {})
    principal_name = principal_info.get("name", "the principal")
    
    console.print(f"  [{Colors.NEUTRAL}]Now let's create an authority policy for {principal_name}.")
    console.print(f"  [{Colors.DIM}]Policies define how mandates can be issued.[/]")
    console.print()
    
    max_validity = prompt.number(
        "Maximum mandate validity (seconds)",
        default=3600,
        min_value=60,
    )
    
    wizard.context["first_policy"] = {
        "max_validity_seconds": int(max_validity),
        "resource_patterns": ["api:*", "database:*"],
        "actions": ["api_call", "database_query"],
    }
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Policy will be created after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Max Validity: {int(max_validity)}s[/]")
    
    return wizard.context["first_policy"]


def _step_mandate(wizard: Wizard) -> Any:
    """Step 5: Issue first mandate."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    principal_info = wizard.context.get("first_principal", {})
    principal_name = principal_info.get("name", "the principal")
    
    console.print(f"  [{Colors.NEUTRAL}]Let's issue an execution mandate for {principal_name}.")
    console.print(f"  [{Colors.DIM}]Mandates grant specific execution rights for a limited time.[/]")
    console.print()
    
    validity = prompt.number(
        "Mandate validity (seconds)",
        default=1800,
        min_value=60,
    )
    
    wizard.context["first_mandate"] = {
        "validity_seconds": int(validity),
        "resource_scope": ["api:openai:*"],
        "action_scope": ["api_call"],
    }
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Mandate will be issued after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Validity: {int(validity)}s[/]")
    
    return wizard.context["first_mandate"]


def _step_validate(wizard: Wizard) -> Any:
    """Step 6: Validate mandate demo."""
    console = wizard.console
    
    console.print(f"  [{Colors.NEUTRAL}]Finally, we'll demonstrate mandate validation.")
    console.print(f"  [{Colors.DIM}]This shows how authority is checked before execution.[/]")
    console.print()
    
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Validation demo will run after setup completes.[/]")
    
    wizard.context["validate_demo"] = True
    
    return True


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
            key="principal",
            title="Register First Principal",
            description="Create your first principal identity",
            action=_step_principal,
            skippable=True,
            skip_message="You can register principals later from the main menu",
        ),
        WizardStep(
            key="policy",
            title="Create First Authority Policy",
            description="Set up an authority policy for your principal",
            action=_step_policy,
            skippable=True,
            skip_message="You can create policies later from the main menu",
        ),
        WizardStep(
            key="mandate",
            title="Issue First Mandate",
            description="Create an execution mandate",
            action=_step_mandate,
            skippable=True,
            skip_message="You can issue mandates later from the main menu",
        ),
        WizardStep(
            key="validate",
            title="Validate Mandate Demo",
            description="Demonstrate mandate validation",
            action=_step_validate,
            skippable=True,
            skip_message="You can validate mandates later from the main menu",
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
        from caracal.config import load_config
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        from caracal.db.models import Principal, AuthorityPolicy
        from datetime import datetime
        from uuid import uuid4
        
        # Load fresh config (in case it was just initialized)
        config = load_config()
        
        # Save database configuration if provided
        db_config_data = results.get("database")
        if db_config_data and isinstance(db_config_data, dict):
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Saving database configuration...[/]")
            
            # Update config file with database settings
            import yaml
            from pathlib import Path
            
            config_path = wizard.context.get("config_path", Path.home() / ".caracal")
            config_file = Path(config_path) / "config.yaml"
            
            if config_file.exists():
                with open(config_file, 'r') as f:
                    config_yaml = yaml.safe_load(f) or {}
                
                # Update database section
                config_yaml['database'] = {
                    'type': 'postgres',
                    'host': db_config_data['host'],
                    'port': db_config_data['port'],
                    'database': db_config_data['database'],
                    'user': db_config_data['username'],
                    'password': db_config_data['password'],
                }
                
                with open(config_file, 'w') as f:
                    yaml.dump(config_yaml, f, default_flow_style=False)
                
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Database configuration saved to config.yaml[/]")
                
                # Reload config
                config = load_config()
        
        # Setup database connection
        if hasattr(config, 'database') and config.database:
            db_config = DatabaseConfig(
                type=getattr(config.database, 'type', 'sqlite'),
                host=getattr(config.database, 'host', 'localhost'),
                port=getattr(config.database, 'port', 5432),
                database=getattr(config.database, 'database', 'caracal'),
                user=getattr(config.database, 'user', 'caracal'),
                password=getattr(config.database, 'password', ''),
                file_path=getattr(config.database, 'file_path', str(Path.home() / ".caracal" / "caracal.db")),
            )
        else:
            # Default to SQLite
            db_config = DatabaseConfig(
                type='sqlite',
                file_path=str(Path.home() / ".caracal" / "caracal.db"),
            )
        
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        # Handle Principal Registration
        principal_data = results.get("principal")
        principal_id = None
        
        if principal_data:
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Finalizing setup...[/]")
            
            try:
                with db_manager.session_scope() as db_session:
                    principal = Principal(
                        name=principal_data["name"],
                        principal_type=principal_data["type"],
                        owner=principal_data["owner"],
                        created_at=datetime.utcnow(),
                    )
                    
                    db_session.add(principal)
                    db_session.flush()
                    
                    principal_id = principal.principal_id
                    
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal registered successfully.[/]")
                console.print(f"  [{Colors.DIM}]Principal ID: {principal_id}[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to register principal: {e}[/]")
        
        # Handle Authority Policy Creation
        policy_data = results.get("policy")
        if policy_data and principal_id:
            try:
                with db_manager.session_scope() as db_session:
                    policy = AuthorityPolicy(
                        policy_id=uuid4(),
                        principal_id=principal_id,
                        max_validity_seconds=policy_data["max_validity_seconds"],
                        allowed_resource_patterns=policy_data["resource_patterns"],
                        allowed_actions=policy_data["actions"],
                        allow_delegation=True,
                        max_delegation_depth=3,
                        created_at=datetime.utcnow(),
                        created_by=principal_data["owner"] if principal_data else "system",
                        active=True,
                    )
                    
                    db_session.add(policy)
                    
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy created successfully.[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to create policy: {e}[/]")
        
        # Close database connection
        db_manager.close()
                
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error saving configuration: {e}[/]")
        import traceback
        traceback.print_exc()

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
    if results.get("principal") is None:
        todos.append(("Register a principal", "caracal authority register --name my-principal --owner user@example.com"))
    
    if results.get("policy") is None:
        todos.append(("Create an authority policy", "caracal authority-policy create --principal-id <uuid> --max-validity 3600"))
    
    if results.get("mandate") is None:
        todos.append(("Issue an execution mandate", "caracal authority issue --issuer-id <uuid> --subject-id <uuid>"))
    
    if results.get("database") == "file":
        todos.append(("Consider PostgreSQL for production", "Set database.type: postgresql in config.yaml"))
    
    # Always suggest viewing the ledger
    todos.append(("Explore your authority ledger", "caracal authority-ledger query"))
    
    for i, (title, cmd) in enumerate(todos, 1):
        console.print(f"  [{Colors.NEUTRAL}]{i}. {title}[/]")
        console.print(f"     [{Colors.DIM}]{cmd}[/]")
        console.print()
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue to the main menu...[/]")
    input()
