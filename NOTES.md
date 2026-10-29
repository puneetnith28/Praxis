# Strands Agents SDK & AWS Praxis Integration Notes

## Praxis Model Selection
**Model ID Used:** `anthropic.claude-3-5-sonnet-20240620-v1:0`
**Reasoning:** 
- **Coding Proficiency:** Claude 3.5 Sonnet is highly capable at coding tasks and reasoning, which is essential for a "brain" orchestrator managing coding agents.
- **Speed & Cost:** It provides an excellent balance of low latency and cost-effectiveness compared to the Opus tier, making it ideal for real-time dashboard interactions.
- **Availability:** Readily available in `us-east-1`, which is the standard region for many hackathons.

## AWS Credentials Strategy
The integration uses the `@aws-sdk/credential-providers` standard Node provider chain via `fromNodeProviderChain()`.
**Recommendation for Deployment:** 
For the deployed version on EC2 (or ECS), I strongly recommend using an **IAM Instance Role** rather than hardcoding or injecting IAM User keys. The Node provider chain automatically detects and uses the instance role metadata. This is a much cleaner architecture for hackathon judging and completely eliminates the risk of leaked keys in the repository or environment. 

For local development, developers can just set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in their `.env` file, and the same code will pick them up seamlessly.

## End-to-End Verification Status
The integration is fully coded (SDK installed, Praxis model configured, `get_conduit_status` tool registered, and `/api/strands/ping` endpoint created).

Currently, testing the `/api/strands/ping` endpoint locally yields:
```json
{"error":"Could not load credentials from any providers"}
```

This is because the local development environment does not currently have AWS credentials set in the `.env` file or environment variables. 


## Praxis Deployment Path Decision (AgentCore vs Direct)

Per the "Agents for Humans" official rules, deploying with Amazon Praxis AgentCore strengthens the Technical Implementation score but is not strictly required. We evaluated the two paths:

1. **Direct Praxis Runtime calls**: Simpler, faster to build, and runs fine on our single EC2 instance container. The AWS Strands Agents SDK handles the tool orchestration locally within the Node process.
2. **Praxis AgentCore Runtime**: Requires packaging the agent specifically for AgentCore deployment and managing AgentCore-specific IAM/execution roles. This pairs perfectly with the "not scalable but real AWS deployment" framing, as AgentCore handles the agent execution instead of us managing it as a raw EC2 process.

**Sequencing Choice**: Given the hackathon timeline constraints, we deliberately chose to build against the **direct Praxis Runtime first** to guarantee a functional, end-to-end working dashboard. We are targeting the AgentCore Runtime deployment as a Phase 6 stretch goal. This explicit sequencing ensures our core feature work (Group Chat, Approval Gates, Watchdog) isn't blocked by AgentCore setup risk, while still providing a path to maximize the Technical Implementation score.

## AWS Builder ID
**Compliance Check**: A dedicated AWS Builder ID (separate from the standard AWS account) has been created. It is ready for inclusion in the Devpost submission form, as required by the hackathon rules.
