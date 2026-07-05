\# FlowSync Privacy Policy



\*Last updated: 05 July 2026\*



FlowSync ("we", "our", "the app") is a financial reporting tool built for the Rise of the Builder: Xero App \& Agent Hackathon (Encode Club × Xero). This policy explains what data FlowSync accesses, how it's used, and how it's protected.



\## What data we access



When you connect a Xero organisation to FlowSync, we request read access to:



\- Organisation details (name, country, base currency, tax registration status)

\- Invoices, Contacts, and Accounts

\- Profit \& Loss, Balance Sheet, and Bank Summary reports

\- Your Xero identity (name, email) for sign-in



FlowSync also writes limited demo data (sample contacts and bank transactions) to sandbox/demo organisations only, for testing purposes.



\## How we use it



\- \*\*Consolidated reporting\*\* — combining financial data across your connected Xero organisations into dashboards, currency conversions, and tax estimates.

\- \*\*Automated reports\*\* — generating and emailing PDF financial summaries on a schedule you control.

\- \*\*AI features\*\* — our Legislation Assistant uses your connected financial data (never your Xero credentials) to answer tax/compliance questions, grounded in live web search of official tax authority sources.



\## What we don't do



\- We never sell or share your financial data with third parties.

\- Your Xero access token, refresh token, and Xero client credentials never pass through any AI/LLM component — only report figures and short status messages do.

\- We never request more Xero API scopes than the specific features above require.



\## Where your data is stored



\- Xero access and refresh tokens are stored securely server-side (Supabase, with row-level security), never in your browser.

\- Financial data used for reporting is fetched live from Xero at the time you use the app; we do not maintain a long-term duplicate database of your Xero transactions beyond what's needed for scheduled report generation and loss/FX alerting.



\## Managing your connection



You can view and disconnect any connected Xero organisation at any time from FlowSync's \*\*Xero Connections\*\* settings page. Disconnecting immediately revokes FlowSync's access on Xero's side.



\## Contact



This is a hackathon project. For questions about this policy or your data, please open an issue on the project's GitHub repository.

