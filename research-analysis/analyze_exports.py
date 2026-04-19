from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from scipy import stats


def safe_read_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"missing file: {path}")
    return pd.read_csv(path)


def ensure_numeric(frame: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    for column in columns:
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame


def save_table(frame: pd.DataFrame, output_dir: Path, name: str) -> None:
    frame.to_csv(output_dir / f"{name}.csv", index=False, encoding="utf-8-sig")


def save_figure(fig: plt.Figure, output_dir: Path, name: str) -> None:
    fig.tight_layout()
    fig.savefig(output_dir / f"{name}.png", dpi=220, bbox_inches="tight")
    plt.close(fig)


def group_summary(participants: pd.DataFrame) -> pd.DataFrame:
    grouped = participants.groupby("groupId", dropna=False).agg(
        participantCount=("participantId", "count"),
        analysisCount=("analysisCount", "mean"),
        pretestPitchMean=("pretestPitch", "mean"),
        posttestPitchMean=("posttestPitch", "mean"),
        pitchGainMean=("pitchGain", "mean"),
        pretestRhythmMean=("pretestRhythm", "mean"),
        posttestRhythmMean=("posttestRhythm", "mean"),
        rhythmGainMean=("rhythmGain", "mean"),
        usefulnessMean=("usefulness", "mean"),
        continuanceMean=("continuance", "mean"),
        questionnaireCountMean=("questionnaireCount", "mean"),
    )
    return grouped.reset_index()


def ttest_summary(participants: pd.DataFrame) -> pd.DataFrame:
    rows = []
    experimental = participants.loc[participants["groupId"] == "experimental"]
    control = participants.loc[participants["groupId"] == "control"]
    metrics = ["pitchGain", "rhythmGain", "usefulness", "continuance", "analysisCount"]
    for metric in metrics:
        exp_values = experimental[metric].dropna()
        ctl_values = control[metric].dropna()
        if len(exp_values) >= 2 and len(ctl_values) >= 2:
            statistic, p_value = stats.ttest_ind(exp_values, ctl_values, equal_var=False)
        else:
            statistic, p_value = float("nan"), float("nan")
        rows.append(
            {
                "metric": metric,
                "experimentalMean": exp_values.mean() if len(exp_values) else float("nan"),
                "controlMean": ctl_values.mean() if len(ctl_values) else float("nan"),
                "tStatistic": statistic,
                "pValue": p_value,
            }
        )
    return pd.DataFrame(rows)


def questionnaire_summary(questionnaires: pd.DataFrame) -> pd.DataFrame:
    metrics = ["usefulness", "easeOfUse", "feedbackClarity", "confidence", "continuance"]
    grouped = questionnaires.groupby(["groupId", "sessionStage"], dropna=False)[metrics].mean().reset_index()
    return grouped.sort_values(["groupId", "sessionStage"])


def build_expert_system_table(participants: pd.DataFrame) -> pd.DataFrame:
    rows = []
    pairs = [
        ("pretestPitch", "expertPretestPitch"),
        ("posttestPitch", "expertPosttestPitch"),
        ("pretestRhythm", "expertPretestRhythm"),
        ("posttestRhythm", "expertPosttestRhythm"),
    ]
    for system_col, expert_col in pairs:
        subset = participants[[system_col, expert_col]].dropna()
        if len(subset) >= 3:
            corr, p_value = stats.pearsonr(subset[system_col], subset[expert_col])
        else:
            corr, p_value = float("nan"), float("nan")
        rows.append(
            {
                "systemMetric": system_col,
                "expertMetric": expert_col,
                "sampleSize": len(subset),
                "pearsonR": corr,
                "pValue": p_value,
            }
        )
    return pd.DataFrame(rows)


def build_analysis_usage_table(analyses: pd.DataFrame) -> pd.DataFrame:
    grouped = analyses.groupby(["participantId", "sessionStage"], dropna=False).agg(
        analysisRuns=("analysisId", "count"),
        meanPitchScore=("overallPitchScore", "mean"),
        meanRhythmScore=("overallRhythmScore", "mean"),
        meanConfidence=("confidence", "mean"),
    )
    return grouped.reset_index().sort_values(["participantId", "sessionStage"])


def plot_gain_by_group(participants: pd.DataFrame, output_dir: Path) -> None:
    plot_frame = participants.melt(
        id_vars=["participantId", "groupId"],
        value_vars=["pitchGain", "rhythmGain"],
        var_name="metric",
        value_name="value",
    ).dropna()
    fig, ax = plt.subplots(figsize=(9, 5))
    sns.boxplot(data=plot_frame, x="metric", y="value", hue="groupId", ax=ax)
    sns.stripplot(data=plot_frame, x="metric", y="value", hue="groupId", dodge=True, ax=ax, alpha=0.45, linewidth=0)
    handles, labels = ax.get_legend_handles_labels()
    ax.legend(handles[:2], labels[:2], title="group")
    ax.set_title("System Gains by Group")
    ax.set_xlabel("")
    ax.set_ylabel("Gain")
    save_figure(fig, output_dir, "figure_gain_by_group")


def plot_questionnaire_bars(questionnaires: pd.DataFrame, output_dir: Path) -> None:
    metrics = ["usefulness", "easeOfUse", "feedbackClarity", "confidence", "continuance"]
    summary = questionnaires.groupby("groupId", dropna=False)[metrics].mean().reset_index()
    plot_frame = summary.melt(id_vars=["groupId"], value_vars=metrics, var_name="metric", value_name="score")
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.barplot(data=plot_frame, x="metric", y="score", hue="groupId", ax=ax)
    ax.set_title("Questionnaire Means by Group")
    ax.set_xlabel("")
    ax.set_ylabel("Mean score")
    ax.set_ylim(0, 5.2)
    save_figure(fig, output_dir, "figure_questionnaire_by_group")


def plot_system_vs_expert(participants: pd.DataFrame, output_dir: Path) -> None:
    subset = participants[["posttestPitch", "expertPosttestPitch", "groupId"]].dropna()
    if subset.empty:
        return
    fig, ax = plt.subplots(figsize=(6, 6))
    sns.scatterplot(data=subset, x="posttestPitch", y="expertPosttestPitch", hue="groupId", ax=ax, s=70)
    if len(subset) >= 2:
        sns.regplot(data=subset, x="posttestPitch", y="expertPosttestPitch", scatter=False, ax=ax, color="#444444")
    ax.set_title("System vs Expert Posttest Pitch")
    ax.set_xlabel("System score")
    ax.set_ylabel("Expert score")
    save_figure(fig, output_dir, "figure_system_vs_expert")


def plot_usage_vs_gain(participants: pd.DataFrame, output_dir: Path) -> None:
    subset = participants[["analysisCount", "pitchGain", "groupId"]].dropna()
    if subset.empty:
        return
    fig, ax = plt.subplots(figsize=(7, 5))
    sns.scatterplot(data=subset, x="analysisCount", y="pitchGain", hue="groupId", ax=ax, s=70)
    if len(subset) >= 2:
        sns.regplot(data=subset, x="analysisCount", y="pitchGain", scatter=False, ax=ax, color="#444444")
    ax.set_title("Analysis Usage vs Pitch Gain")
    ax.set_xlabel("Analysis count")
    ax.set_ylabel("Pitch gain")
    save_figure(fig, output_dir, "figure_usage_vs_pitch_gain")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate SSCI-ready tables and figures from exported study CSV files.")
    parser.add_argument("--participants", required=True, type=Path)
    parser.add_argument("--questionnaires", required=True, type=Path)
    parser.add_argument("--ratings", required=True, type=Path)
    parser.add_argument("--analyses", required=True, type=Path)
    parser.add_argument("--output-dir", default=Path("research-analysis/output"), type=Path)
    args = parser.parse_args()

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    sns.set_theme(style="whitegrid", palette="deep")

    participants = safe_read_csv(args.participants)
    questionnaires = safe_read_csv(args.questionnaires)
    ratings = safe_read_csv(args.ratings)
    analyses = safe_read_csv(args.analyses)

    participants = ensure_numeric(
        participants,
        [
            "analysisCount",
            "weeklySessionCount",
            "pretestPitch",
            "posttestPitch",
            "pretestRhythm",
            "posttestRhythm",
            "pitchGain",
            "rhythmGain",
            "usefulness",
            "easeOfUse",
            "feedbackClarity",
            "confidence",
            "continuance",
            "questionnaireCount",
            "expertPretestPitch",
            "expertPosttestPitch",
            "expertPretestRhythm",
            "expertPosttestRhythm",
        ],
    )
    questionnaires = ensure_numeric(
        questionnaires,
        ["usefulness", "easeOfUse", "feedbackClarity", "confidence", "continuance"],
    )
    ratings = ensure_numeric(ratings, ["pitchScore", "rhythmScore"])
    analyses = ensure_numeric(analyses, ["overallPitchScore", "overallRhythmScore", "confidence"])

    save_table(participants, output_dir, "table_participant_overview")
    save_table(group_summary(participants), output_dir, "table_group_summary")
    save_table(ttest_summary(participants), output_dir, "table_group_ttests")
    save_table(questionnaire_summary(questionnaires), output_dir, "table_questionnaire_summary")
    save_table(build_expert_system_table(participants), output_dir, "table_system_expert_correlations")
    save_table(build_analysis_usage_table(analyses), output_dir, "table_analysis_usage")
    save_table(ratings.sort_values(["participantId", "stage", "submittedAt"]), output_dir, "table_expert_ratings_raw")

    plot_gain_by_group(participants, output_dir)
    plot_questionnaire_bars(questionnaires, output_dir)
    plot_system_vs_expert(participants, output_dir)
    plot_usage_vs_gain(participants, output_dir)

    summary_path = output_dir / "README.txt"
    summary_path.write_text(
        "\n".join(
            [
                "Generated files:",
                "- table_participant_overview.csv",
                "- table_group_summary.csv",
                "- table_group_ttests.csv",
                "- table_questionnaire_summary.csv",
                "- table_system_expert_correlations.csv",
                "- table_analysis_usage.csv",
                "- table_expert_ratings_raw.csv",
                "- figure_gain_by_group.png",
                "- figure_questionnaire_by_group.png",
                "- figure_system_vs_expert.png",
                "- figure_usage_vs_pitch_gain.png",
            ]
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
