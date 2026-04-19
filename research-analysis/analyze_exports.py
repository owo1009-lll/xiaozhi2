from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from scipy import stats
from statsmodels.formula.api import ols
from statsmodels.stats.anova import anova_lm


PARTICIPANT_NUMERIC_COLUMNS = [
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
]

QUESTIONNAIRE_NUMERIC_COLUMNS = ["usefulness", "easeOfUse", "feedbackClarity", "confidence", "continuance"]
RATING_NUMERIC_COLUMNS = ["pitchScore", "rhythmScore"]
ANALYSIS_NUMERIC_COLUMNS = ["overallPitchScore", "overallRhythmScore", "confidence"]

PREPOST_TIME_ORDER = ["pretest", "posttest"]
METRIC_SPECS = [
    ("pitch", "pretestPitch", "posttestPitch"),
    ("rhythm", "pretestRhythm", "posttestRhythm"),
]


def safe_read_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"missing file: {path}")
    return pd.read_csv(path)


def ensure_columns(frame: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    for column in columns:
        if column not in frame.columns:
            frame[column] = pd.NA
    return frame


def ensure_numeric(frame: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    frame = ensure_columns(frame, columns)
    for column in columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame


def save_table(frame: pd.DataFrame, output_dir: Path, name: str) -> None:
    frame.to_csv(output_dir / f"{name}.csv", index=False, encoding="utf-8-sig")


def save_figure(fig: plt.Figure, output_dir: Path, name: str) -> None:
    fig.tight_layout()
    fig.savefig(output_dir / f"{name}.png", dpi=220, bbox_inches="tight")
    plt.close(fig)


def round_value(value: float | int | None, digits: int = 3) -> float | None:
    if value is None or pd.isna(value):
        return None
    return round(float(value), digits)


def safe_mean(series: pd.Series) -> float:
    cleaned = series.dropna()
    if cleaned.empty:
        return float("nan")
    return float(cleaned.mean())


def safe_pearsonr(x: pd.Series, y: pd.Series) -> tuple[float, float, int]:
    subset = pd.DataFrame({"x": x, "y": y}).dropna()
    if len(subset) < 3 or subset["x"].nunique() < 2 or subset["y"].nunique() < 2:
        return float("nan"), float("nan"), len(subset)
    corr, p_value = stats.pearsonr(subset["x"], subset["y"])
    return float(corr), float(p_value), len(subset)


def placeholder_figure(title: str, message: str = "No data available") -> plt.Figure:
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.axis("off")
    ax.text(0.5, 0.62, title, ha="center", va="center", fontsize=15, fontweight="bold")
    ax.text(0.5, 0.45, message, ha="center", va="center", fontsize=11, color="#555555")
    return fig


def add_placeholder_axis(ax: plt.Axes, title: str, message: str = "No data available") -> None:
    ax.axis("off")
    ax.text(0.5, 0.6, title, ha="center", va="center", fontsize=13, fontweight="bold")
    ax.text(0.5, 0.42, message, ha="center", va="center", fontsize=10, color="#555555")


def group_summary(participants: pd.DataFrame) -> pd.DataFrame:
    participants = ensure_columns(
        participants,
        [
            "participantId",
            "groupId",
            "analysisCount",
            "pretestPitch",
            "posttestPitch",
            "pitchGain",
            "pretestRhythm",
            "posttestRhythm",
            "rhythmGain",
            "usefulness",
            "continuance",
            "questionnaireCount",
        ],
    )
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
    participants = ensure_columns(participants, ["groupId", "pitchGain", "rhythmGain", "usefulness", "continuance", "analysisCount"])
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
                "experimentalMean": safe_mean(exp_values),
                "controlMean": safe_mean(ctl_values),
                "tStatistic": statistic,
                "pValue": p_value,
            }
        )
    return pd.DataFrame(rows)


def questionnaire_summary(questionnaires: pd.DataFrame) -> pd.DataFrame:
    questionnaires = ensure_columns(questionnaires, ["groupId", "sessionStage", *QUESTIONNAIRE_NUMERIC_COLUMNS])
    grouped = questionnaires.groupby(["groupId", "sessionStage"], dropna=False)[QUESTIONNAIRE_NUMERIC_COLUMNS].mean().reset_index()
    return grouped.sort_values(["groupId", "sessionStage"])


def build_expert_system_table(participants: pd.DataFrame) -> pd.DataFrame:
    participants = ensure_columns(
        participants,
        ["pretestPitch", "expertPretestPitch", "posttestPitch", "expertPosttestPitch", "pretestRhythm", "expertPretestRhythm", "posttestRhythm", "expertPosttestRhythm"],
    )
    rows = []
    pairs = [
        ("pretestPitch", "expertPretestPitch"),
        ("posttestPitch", "expertPosttestPitch"),
        ("pretestRhythm", "expertPretestRhythm"),
        ("posttestRhythm", "expertPosttestRhythm"),
    ]
    for system_col, expert_col in pairs:
        corr, p_value, sample_size = safe_pearsonr(participants[system_col], participants[expert_col])
        rows.append(
            {
                "systemMetric": system_col,
                "expertMetric": expert_col,
                "sampleSize": sample_size,
                "pearsonR": corr,
                "pValue": p_value,
            }
        )
    return pd.DataFrame(rows)


def build_analysis_usage_table(analyses: pd.DataFrame) -> pd.DataFrame:
    analyses = ensure_columns(analyses, ["participantId", "sessionStage", "analysisId", "overallPitchScore", "overallRhythmScore", "confidence"])
    grouped = analyses.groupby(["participantId", "sessionStage"], dropna=False).agg(
        analysisRuns=("analysisId", "count"),
        meanPitchScore=("overallPitchScore", "mean"),
        meanRhythmScore=("overallRhythmScore", "mean"),
        meanConfidence=("confidence", "mean"),
    )
    return grouped.reset_index().sort_values(["participantId", "sessionStage"])


def build_usage_correlation_table(participants: pd.DataFrame) -> pd.DataFrame:
    participants = ensure_columns(participants, ["analysisCount", "pitchGain", "rhythmGain"])
    rows = []
    for metric in ["pitchGain", "rhythmGain"]:
        corr, p_value, sample_size = safe_pearsonr(participants["analysisCount"], participants[metric])
        rows.append(
            {
                "predictor": "analysisCount",
                "outcome": metric,
                "sampleSize": sample_size,
                "pearsonR": corr,
                "pValue": p_value,
            }
        )
    return pd.DataFrame(rows)


def build_prepost_long_table(participants: pd.DataFrame) -> pd.DataFrame:
    participants = ensure_columns(participants, ["participantId", "groupId", "pretestPitch", "posttestPitch", "pretestRhythm", "posttestRhythm"])
    rows: list[dict[str, object]] = []
    for metric, pre_col, post_col in METRIC_SPECS:
        subset = participants[["participantId", "groupId", pre_col, post_col]].copy()
        for _, row in subset.iterrows():
            if pd.notna(row[pre_col]):
                rows.append(
                    {
                        "participantId": row["participantId"],
                        "groupId": row["groupId"],
                        "metric": metric,
                        "time": "pretest",
                        "score": row[pre_col],
                    }
                )
            if pd.notna(row[post_col]):
                rows.append(
                    {
                        "participantId": row["participantId"],
                        "groupId": row["groupId"],
                        "metric": metric,
                        "time": "posttest",
                        "score": row[post_col],
                    }
                )
    long_table = pd.DataFrame(rows, columns=["participantId", "groupId", "metric", "time", "score"])
    if not long_table.empty:
        long_table["time"] = pd.Categorical(long_table["time"], categories=PREPOST_TIME_ORDER, ordered=True)
        long_table = long_table.sort_values(["metric", "groupId", "participantId", "time"])
    return long_table


def build_prepost_summary(long_table: pd.DataFrame) -> pd.DataFrame:
    long_table = ensure_columns(long_table, ["metric", "groupId", "time", "score"])
    if long_table.empty:
        return pd.DataFrame(columns=["metric", "groupId", "time", "sampleSize", "meanScore", "sd", "sem"])
    grouped = long_table.groupby(["metric", "groupId", "time"], dropna=False).agg(
        sampleSize=("score", "count"),
        meanScore=("score", "mean"),
        sd=("score", "std"),
        sem=("score", "sem"),
    )
    summary = grouped.reset_index()
    summary["time"] = pd.Categorical(summary["time"], categories=PREPOST_TIME_ORDER, ordered=True)
    return summary.sort_values(["metric", "groupId", "time"])


def build_ancova_table(participants: pd.DataFrame) -> pd.DataFrame:
    participants = ensure_columns(participants, ["participantId", "groupId", "pretestPitch", "posttestPitch", "pretestRhythm", "posttestRhythm"])
    rows = []
    for metric, pre_col, post_col in METRIC_SPECS:
        subset = participants[["participantId", "groupId", pre_col, post_col]].dropna().copy()
        subset["groupId"] = subset["groupId"].astype("string")
        if len(subset) < 4 or subset["groupId"].nunique() < 2:
            for term in ["groupId", "pretest"]:
                rows.append(
                    {
                        "metric": metric,
                        "term": term,
                        "sampleSize": len(subset),
                        "degreesOfFreedom": float("nan"),
                        "sumSquares": float("nan"),
                        "fStatistic": float("nan"),
                        "pValue": float("nan"),
                        "partialEtaSquared": float("nan"),
                        "adjustedRsquared": float("nan"),
                    }
                )
            continue

        try:
            model = ols(f"{post_col} ~ C(groupId) + {pre_col}", data=subset).fit()
            anova_table = anova_lm(model, typ=2)
            residual_ss = float(anova_table.loc["Residual", "sum_sq"]) if "Residual" in anova_table.index else float("nan")
            adjusted_rsq = float(model.rsquared_adj)
            term_lookup = {
                "C(groupId)": "groupId",
                pre_col: "pretest",
            }

            for source_name, term in term_lookup.items():
                if source_name not in anova_table.index:
                    rows.append(
                        {
                            "metric": metric,
                            "term": term,
                            "sampleSize": len(subset),
                            "degreesOfFreedom": float("nan"),
                            "sumSquares": float("nan"),
                            "fStatistic": float("nan"),
                            "pValue": float("nan"),
                            "partialEtaSquared": float("nan"),
                            "adjustedRsquared": adjusted_rsq,
                        }
                    )
                    continue

                sum_squares = float(anova_table.loc[source_name, "sum_sq"])
                partial_eta = float("nan")
                if pd.notna(residual_ss) and (sum_squares + residual_ss) > 0:
                    partial_eta = sum_squares / (sum_squares + residual_ss)
                rows.append(
                    {
                        "metric": metric,
                        "term": term,
                        "sampleSize": len(subset),
                        "degreesOfFreedom": float(anova_table.loc[source_name, "df"]),
                        "sumSquares": sum_squares,
                        "fStatistic": float(anova_table.loc[source_name, "F"]),
                        "pValue": float(anova_table.loc[source_name, "PR(>F)"]),
                        "partialEtaSquared": partial_eta,
                        "adjustedRsquared": adjusted_rsq,
                    }
                )
        except Exception:
            for term in ["groupId", "pretest"]:
                rows.append(
                    {
                        "metric": metric,
                        "term": term,
                        "sampleSize": len(subset),
                        "degreesOfFreedom": float("nan"),
                        "sumSquares": float("nan"),
                        "fStatistic": float("nan"),
                        "pValue": float("nan"),
                        "partialEtaSquared": float("nan"),
                        "adjustedRsquared": float("nan"),
                    }
                )
    return pd.DataFrame(rows)


def write_summary_report(
    output_dir: Path,
    participants: pd.DataFrame,
    group_table: pd.DataFrame,
    ttest_table: pd.DataFrame,
    expert_table: pd.DataFrame,
    usage_corr_table: pd.DataFrame,
    ancova_table: pd.DataFrame,
    prepost_summary: pd.DataFrame,
) -> None:
    participants = ensure_columns(participants, ["groupId"])
    participant_count = len(participants)
    experimental_count = int((participants["groupId"] == "experimental").sum())
    control_count = int((participants["groupId"] == "control").sum())

    group_lookup = {row["groupId"]: row for _, row in group_table.iterrows()}
    exp_group = group_lookup.get("experimental", {})
    ctl_group = group_lookup.get("control", {})

    lines = [
        "# Research Summary",
        "",
        f"- Participants: {participant_count}",
        f"- Experimental group: {experimental_count}",
        f"- Control group: {control_count}",
        "",
        "## Group Means",
        f"- Experimental pitch gain mean: {round_value(exp_group.get('pitchGainMean'), 2)}",
        f"- Control pitch gain mean: {round_value(ctl_group.get('pitchGainMean'), 2)}",
        f"- Experimental rhythm gain mean: {round_value(exp_group.get('rhythmGainMean'), 2)}",
        f"- Control rhythm gain mean: {round_value(ctl_group.get('rhythmGainMean'), 2)}",
        f"- Experimental usefulness mean: {round_value(exp_group.get('usefulnessMean'), 2)}",
        f"- Control usefulness mean: {round_value(ctl_group.get('usefulnessMean'), 2)}",
        "",
        "## Group Tests",
    ]

    for _, row in ttest_table.iterrows():
        lines.append(
            f"- {row['metric']}: experimental={round_value(row['experimentalMean'], 3)}, "
            f"control={round_value(row['controlMean'], 3)}, "
            f"t={round_value(row['tStatistic'], 3)}, p={round_value(row['pValue'], 4)}"
        )

    lines.extend(["", "## Pre/Post Summary"])
    if prepost_summary.empty:
        lines.append("- No paired score data available yet.")
    else:
        for _, row in prepost_summary.iterrows():
            lines.append(
                f"- {row['metric']} | {row['groupId']} | {row['time']}: "
                f"n={int(row['sampleSize'])}, mean={round_value(row['meanScore'], 3)}, sem={round_value(row['sem'], 3)}"
            )

    lines.extend(["", "## ANCOVA"])
    for _, row in ancova_table.iterrows():
        lines.append(
            f"- {row['metric']} {row['term']}: "
            f"n={int(row['sampleSize']) if pd.notna(row['sampleSize']) else 0}, "
            f"F={round_value(row['fStatistic'], 3)}, p={round_value(row['pValue'], 4)}, "
            f"partial_eta_sq={round_value(row['partialEtaSquared'], 4)}, "
            f"adj_R2={round_value(row['adjustedRsquared'], 4)}"
        )

    lines.extend(["", "## System vs Expert Correlations"])
    for _, row in expert_table.iterrows():
        lines.append(
            f"- {row['systemMetric']} vs {row['expertMetric']}: "
            f"n={int(row['sampleSize'])}, r={round_value(row['pearsonR'], 3)}, p={round_value(row['pValue'], 4)}"
        )

    lines.extend(["", "## Usage Correlations"])
    for _, row in usage_corr_table.iterrows():
        lines.append(
            f"- analysisCount vs {row['outcome']}: "
            f"n={int(row['sampleSize'])}, r={round_value(row['pearsonR'], 3)}, p={round_value(row['pValue'], 4)}"
        )

    (output_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")


def write_summary_json(
    output_dir: Path,
    group_table: pd.DataFrame,
    ttest_table: pd.DataFrame,
    expert_table: pd.DataFrame,
    usage_corr_table: pd.DataFrame,
    ancova_table: pd.DataFrame,
    prepost_summary: pd.DataFrame,
) -> None:
    payload = {
        "groupSummary": group_table.to_dict(orient="records"),
        "groupTests": ttest_table.to_dict(orient="records"),
        "prePostSummary": prepost_summary.to_dict(orient="records"),
        "ancova": ancova_table.to_dict(orient="records"),
        "systemExpertCorrelations": expert_table.to_dict(orient="records"),
        "usageCorrelations": usage_corr_table.to_dict(orient="records"),
    }
    (output_dir / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def plot_gain_by_group(participants: pd.DataFrame, output_dir: Path) -> None:
    participants = ensure_columns(participants, ["participantId", "groupId", "pitchGain", "rhythmGain"])
    plot_frame = participants.melt(
        id_vars=["participantId", "groupId"],
        value_vars=["pitchGain", "rhythmGain"],
        var_name="metric",
        value_name="value",
    ).dropna()
    if plot_frame.empty:
        save_figure(placeholder_figure("System Gains by Group"), output_dir, "figure_gain_by_group")
        return

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
    questionnaires = ensure_columns(questionnaires, ["groupId", *QUESTIONNAIRE_NUMERIC_COLUMNS])
    summary = questionnaires.groupby("groupId", dropna=False)[QUESTIONNAIRE_NUMERIC_COLUMNS].mean().reset_index()
    plot_frame = summary.melt(id_vars=["groupId"], value_vars=QUESTIONNAIRE_NUMERIC_COLUMNS, var_name="metric", value_name="score").dropna()
    if plot_frame.empty:
        save_figure(placeholder_figure("Questionnaire Means by Group"), output_dir, "figure_questionnaire_by_group")
        return

    fig, ax = plt.subplots(figsize=(10, 5))
    sns.barplot(data=plot_frame, x="metric", y="score", hue="groupId", ax=ax)
    ax.set_title("Questionnaire Means by Group")
    ax.set_xlabel("")
    ax.set_ylabel("Mean score")
    ax.set_ylim(0, 5.2)
    save_figure(fig, output_dir, "figure_questionnaire_by_group")


def plot_system_vs_expert(participants: pd.DataFrame, output_dir: Path) -> None:
    participants = ensure_columns(participants, ["posttestPitch", "expertPosttestPitch", "groupId"])
    subset = participants[["posttestPitch", "expertPosttestPitch", "groupId"]].dropna()
    if subset.empty:
        save_figure(placeholder_figure("System vs Expert Posttest Pitch"), output_dir, "figure_system_vs_expert")
        return

    fig, ax = plt.subplots(figsize=(6, 6))
    sns.scatterplot(data=subset, x="posttestPitch", y="expertPosttestPitch", hue="groupId", ax=ax, s=70)
    if len(subset) >= 2 and subset["posttestPitch"].nunique() > 1 and subset["expertPosttestPitch"].nunique() > 1:
        sns.regplot(data=subset, x="posttestPitch", y="expertPosttestPitch", scatter=False, ax=ax, color="#444444")
    ax.set_title("System vs Expert Posttest Pitch")
    ax.set_xlabel("System score")
    ax.set_ylabel("Expert score")
    save_figure(fig, output_dir, "figure_system_vs_expert")


def plot_usage_vs_gain(participants: pd.DataFrame, output_dir: Path) -> None:
    participants = ensure_columns(participants, ["analysisCount", "pitchGain", "groupId"])
    subset = participants[["analysisCount", "pitchGain", "groupId"]].dropna()
    if subset.empty:
        save_figure(placeholder_figure("Analysis Usage vs Pitch Gain"), output_dir, "figure_usage_vs_pitch_gain")
        return

    fig, ax = plt.subplots(figsize=(7, 5))
    sns.scatterplot(data=subset, x="analysisCount", y="pitchGain", hue="groupId", ax=ax, s=70)
    if len(subset) >= 2 and subset["analysisCount"].nunique() > 1 and subset["pitchGain"].nunique() > 1:
        sns.regplot(data=subset, x="analysisCount", y="pitchGain", scatter=False, ax=ax, color="#444444")
    ax.set_title("Analysis Usage vs Pitch Gain")
    ax.set_xlabel("Analysis count")
    ax.set_ylabel("Pitch gain")
    save_figure(fig, output_dir, "figure_usage_vs_pitch_gain")


def plot_prepost_trends(prepost_summary: pd.DataFrame, output_dir: Path) -> None:
    prepost_summary = ensure_columns(prepost_summary, ["metric", "groupId", "time", "meanScore", "sem"])
    if prepost_summary.empty:
        save_figure(placeholder_figure("Pre/Post Trends by Group"), output_dir, "figure_prepost_trends")
        return

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5), sharey=True)
    metric_titles = {"pitch": "Pitch score", "rhythm": "Rhythm score"}
    x_lookup = {label: index for index, label in enumerate(PREPOST_TIME_ORDER)}

    for ax, metric in zip(axes, ["pitch", "rhythm"]):
        metric_data = prepost_summary.loc[prepost_summary["metric"] == metric].copy()
        if metric_data.empty:
            add_placeholder_axis(ax, metric_titles[metric])
            continue

        for group_id, group_data in metric_data.groupby("groupId", dropna=False):
            group_data = group_data.sort_values("time")
            xs = [x_lookup[str(item)] for item in group_data["time"]]
            ys = group_data["meanScore"].to_list()
            errs = [0 if pd.isna(value) else value for value in group_data["sem"]]
            ax.errorbar(xs, ys, yerr=errs, marker="o", linewidth=2, capsize=4, label=str(group_id))

        ax.set_title(metric_titles[metric])
        ax.set_xticks(list(x_lookup.values()), PREPOST_TIME_ORDER)
        ax.set_xlabel("")
        ax.set_ylabel("Mean score")
        ax.set_ylim(0, 100)
        ax.legend(title="group")

    save_figure(fig, output_dir, "figure_prepost_trends")


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

    participants = ensure_numeric(safe_read_csv(args.participants), PARTICIPANT_NUMERIC_COLUMNS)
    questionnaires = ensure_numeric(safe_read_csv(args.questionnaires), QUESTIONNAIRE_NUMERIC_COLUMNS)
    ratings = ensure_numeric(safe_read_csv(args.ratings), RATING_NUMERIC_COLUMNS)
    analyses = ensure_numeric(safe_read_csv(args.analyses), ANALYSIS_NUMERIC_COLUMNS)

    group_table = group_summary(participants)
    ttest_table = ttest_summary(participants)
    expert_table = build_expert_system_table(participants)
    usage_table = build_analysis_usage_table(analyses)
    usage_corr_table = build_usage_correlation_table(participants)
    prepost_long = build_prepost_long_table(participants)
    prepost_summary = build_prepost_summary(prepost_long)
    ancova_table = build_ancova_table(participants)

    save_table(participants, output_dir, "table_participant_overview")
    save_table(group_table, output_dir, "table_group_summary")
    save_table(ttest_table, output_dir, "table_group_ttests")
    save_table(questionnaire_summary(questionnaires), output_dir, "table_questionnaire_summary")
    save_table(expert_table, output_dir, "table_system_expert_correlations")
    save_table(usage_table, output_dir, "table_analysis_usage")
    save_table(usage_corr_table, output_dir, "table_usage_correlations")
    save_table(prepost_long, output_dir, "table_prepost_long")
    save_table(prepost_summary, output_dir, "table_prepost_summary")
    save_table(ancova_table, output_dir, "table_ancova_summary")
    save_table(ratings.sort_values(["participantId", "stage", "submittedAt"]), output_dir, "table_expert_ratings_raw")

    plot_gain_by_group(participants, output_dir)
    plot_questionnaire_bars(questionnaires, output_dir)
    plot_system_vs_expert(participants, output_dir)
    plot_usage_vs_gain(participants, output_dir)
    plot_prepost_trends(prepost_summary, output_dir)
    write_summary_report(output_dir, participants, group_table, ttest_table, expert_table, usage_corr_table, ancova_table, prepost_summary)
    write_summary_json(output_dir, group_table, ttest_table, expert_table, usage_corr_table, ancova_table, prepost_summary)

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
                "- table_usage_correlations.csv",
                "- table_prepost_long.csv",
                "- table_prepost_summary.csv",
                "- table_ancova_summary.csv",
                "- table_expert_ratings_raw.csv",
                "- figure_gain_by_group.png",
                "- figure_questionnaire_by_group.png",
                "- figure_system_vs_expert.png",
                "- figure_usage_vs_pitch_gain.png",
                "- figure_prepost_trends.png",
                "- report.md",
                "- summary.json",
            ]
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
