mod distill;
mod parser;
mod prompter;
mod report;
mod reports;
mod types;

pub use distill::{
    CommandUsage, DistillCluster, DistillReport, ToolSequence, distill_sessions, render_distill,
};
pub use parser::{ParseError, parse_session};
pub use prompter::{PrompterAggregate, PrompterReport, analyze_prompter, render_prompter};
pub use report::{analyze, compare};
pub use reports::{
    EfficacyEntry, InstructionChange, IntentReport, ModelReport, ProjectReport,
    build_efficacy_report, build_intent_report, build_model_report, build_project_report,
    render_efficacy, render_intents, render_models, render_project,
};
pub use types::{
    AnalysisReport, ComparisonRow, InteractionCounts, McpServerStat, ModelUsage, NormalizedSession,
    Step, ToolCall, ToolStat, Usage,
};
