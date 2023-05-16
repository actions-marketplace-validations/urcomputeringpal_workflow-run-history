import { GitHubScriptArguments } from "@urcomputeringpal/github-script-ts";

interface WorkflowRun {
    id: number;
    status: string;
    created_at: string;
    updated_at: string;
    durationSeconds: number;
    // Add other properties as needed
}

class WorkflowGroup {
    runs: WorkflowRun[];

    constructor(runs: WorkflowRun[]) {
        this.runs = runs;
    }

    getNthPercentileDuration(percentile: number): number {
        const durations = this.runs.map(run => run.durationSeconds);
        const sortedDurations = durations.sort((a, b) => a - b);
        const index = Math.floor((percentile / 100) * sortedDurations.length);
        return sortedDurations[index];
    }

    getPercentileForDuration(durationSeconds: number): number {
        const durations = this.runs.map(run => run.durationSeconds);
        const sortedDurations = durations.sort((a, b) => a - b);
        const index = sortedDurations.findIndex(value => value >= durationSeconds);
        const percentile = (index / sortedDurations.length) * 100;
        return Math.ceil(percentile);
    }
}

type GroupedWorkflowRuns = Map<string, WorkflowGroup>;

async function getWorkflowRuns(workflow_id: number, args: GitHubScriptArguments): Promise<GroupedWorkflowRuns> {
    const workflowRuns: WorkflowRun[] = [];
    const { github, context, core } = args;
    if (github === undefined || context == undefined || core === undefined) {
        throw new Error("need github, context, and core");
    }

    try {
        // FIXME selectable 'created' param to ensure we're using the same time period
        // FIXME also lookup default branch stats, make appropriate comparisons
        for await (const { data: responseWorkflowRuns } of github.paginate.iterator(
            github.rest.actions.listWorkflowRuns,
            {
                ...context.repo,
                workflow_id,
            }
        )) {
            for (const responseWorkflowRun of responseWorkflowRuns) {
                if (responseWorkflowRun.conclusion === undefined) {
                    continue;
                }
                const status = responseWorkflowRun.status as string;

                // ignore a few statuses that also don't count as "finished"
                if (["in_progress", "queued", "requested", "waiting", "pending"].includes(status)) {
                    continue;
                }
                const createdAt = new Date(responseWorkflowRun.created_at);
                const updatedAt = new Date(responseWorkflowRun.updated_at);
                const durationSeconds = Math.floor((updatedAt.getTime() - createdAt.getTime()) / 1000);

                const workflowRun: WorkflowRun = {
                    id: responseWorkflowRun.id,
                    status: status,
                    created_at: responseWorkflowRun.created_at,
                    updated_at: responseWorkflowRun.updated_at,
                    durationSeconds: durationSeconds,
                };
                if (responseWorkflowRun.conclusion !== null) {
                    workflowRun.status = responseWorkflowRun.conclusion;
                }
                workflowRuns.push(workflowRun);
            }
        }
    } catch (error) {
        core.error(`Error loading workflow runs: ${error}`);
    }

    const groupedRuns = new Map<string, WorkflowGroup>();
    workflowRuns.forEach(groupRun => {
        const status = groupRun.status;

        if (!groupedRuns.has(status)) {
            const runs: WorkflowRun[] = [];
            const group = new WorkflowGroup(runs);

            groupedRuns.set(status, group);
        }

        const group = groupedRuns.get(status);
        if (group) {
            group.runs.push(groupRun);
        }
    });

    return groupedRuns;
}

export async function summarizeHistory(args: GitHubScriptArguments): Promise<void> {
    const { github, context, core } = args;
    if (github === undefined || context == undefined || core === undefined) {
        throw new Error("");
    }

    let workflow_id: number = 0;

    while (workflow_id === 0) {
        try {
            const run = await github.rest.actions.getWorkflowRun({
                ...context.repo,
                run_id: context.runId,
            });
            workflow_id = run.data.workflow_id;
        } catch (error) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log("retrying...");
        }
    }

    getWorkflowRuns(workflow_id, { github, context, core }).then(groupedWorkflowRuns => {
        console.log(groupedWorkflowRuns.keys());
        const totalRuns = Array.from(groupedWorkflowRuns.values()).reduce(
            (total, group) => total + group.runs.length,
            0
        );
        core.summary.addHeading(`Workflow Run History (${totalRuns} total runs)`);

        const success = groupedWorkflowRuns.get("success")!;
        const failure = groupedWorkflowRuns.get("failure")!;

        core.summary
            .addHeading(
                `Success rate: ${Math.round(
                    (success.runs.length / (success.runs.length + failure.runs.length)) * 100
                )}% (${success.runs.length} successes out of ${success.runs.length + failure.runs.length} runs)`
            )
            .addHeading(`${success.runs.length} successful runs`)
            .addTable([
                [
                    { data: "Percentile", header: true },
                    { data: "Success duration in seconds", header: true },
                ],
                ["99th", `${success.getNthPercentileDuration(99)}`],
                ["90th", `${success.getNthPercentileDuration(90)}`],
                ["50th", `${success.getNthPercentileDuration(50)}`],
            ])
            .addHeading(`${failure.runs.length} failing runs`)
            .addTable([
                [
                    { data: "Percentile", header: true },
                    { data: "Success duration in seconds", header: true },
                ],
                ["99th", `${failure.getNthPercentileDuration(99)}`],
                ["90th", `${failure.getNthPercentileDuration(90)}`],
                ["50th", `${failure.getNthPercentileDuration(50)}`],
            ]);

        const table = Array.from(groupedWorkflowRuns.keys()).map(status => {
            return [status, `${(groupedWorkflowRuns.get(status)!.runs.length / totalRuns) * 100} % of total`];
        });
        core.summary.addHeading("Run status breakdown").addTable([
            [
                { data: "Status", header: true },
                { data: "Percent of total", header: true },
            ],
            ...table,
        ]);
        core.summary.write();
    });

    return;
}
