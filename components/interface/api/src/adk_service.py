# adk_service.py — Fixed Async Session Creation (Generic ADK Pipeline)
# ============================================

import json
import sys
import asyncio
from google.adk.agents.llm_agent import LlmAgent
from google.adk.agents.sequential_agent import SequentialAgent
from google.adk.sessions import InMemorySessionService
from google.adk.runners import Runner
from google.genai import types as genai_types
from google.adk.agents import Agent, LoopAgent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
from google.adk.code_executors import BuiltInCodeExecutor
from mcp import StdioServerParameters
import os
import subprocess
from typing import Any, Dict


# ============================================================================
# CONFIGURATION
# ============================================================================
LLM_MODEL = os.getenv("LLM_MODEL", "gemini-2.0-flash-exp")  # Use Flash model for faster performance
TARGET_FOLDER_PATH = os.getenv("TARGET_FOLDER_PATH", "/home/coder/project/")
SCRIPT = os.path.join(TARGET_FOLDER_PATH, "output.py")

# Ensure target directory exists
os.makedirs(TARGET_FOLDER_PATH, exist_ok=True)

# ============================================================================
# EVENT EMITTER FOR STREAMING
# ============================================================================
def emit_event(event_type: str, data: Dict[str, Any]):
    """Emit structured JSON event to stderr for streaming to frontend."""
    event_data = {"event": event_type, **data}
    print(json.dumps(event_data), file=sys.stderr, flush=True)



async def run_pipeline_async(user_message: str):

    # ============================================================================
    # Create MCP Toolset per request (prevents concurrency issues)
    # Timeout increased to 30s for Cloud Run cold starts
    # ============================================================================
    filesystem_toolset = McpToolset(
        connection_params=StdioConnectionParams(
            server_params=StdioServerParameters(
                command="npx",
                args=[
                    "-y",
                    "@modelcontextprotocol/server-filesystem",
                    os.path.abspath(TARGET_FOLDER_PATH),
                ],
            ),
            timeout=30  # Increased from default 5s to 30s for Cloud Run
        )
    )

    # Create async in-memory session
    session_service = InMemorySessionService()
    print(f"Current PATH is: {TARGET_FOLDER_PATH}", file=sys.stderr, flush=True)

    await session_service.create_session(
        app_name="node_adk_bridge",
        user_id="node_user",
        session_id="adk_session",
    )

    # Pull optional memory context passed from Node (JSON in ADK_CONTEXT)
    ctx_raw = os.getenv("ADK_CONTEXT", "")
    ctx_summary = ""
    try:
        if ctx_raw:
            ctx = json.loads(ctx_raw)
            c = ctx.get("context", {})
            summary = (c.get("summary") or "").strip()
            recent_msgs = c.get("recentMessages") or []
            notes = c.get("recentMemories") or []
            lines = []
            
            if summary:
                lines.append("Session summary:\n" + summary)
            
            if recent_msgs:
                # Use all messages provided in context (already limited by caller)
                # Format: "role: content"
                msg_lines = [f"- {m.get('role')}: {m.get('content')}" for m in recent_msgs if m.get('content')]
                if msg_lines:
                    lines.append("Recent messages:\n" + "\n".join(msg_lines))
            
            if notes:
                note_lines = []
                for n in notes:
                    text = n.get('text', '')
                    note_lines.append(f"- {text}")
                    
                    # Check for "Artifacts at" pattern to include file listing
                    # Pattern matches: "Artifacts at /path/to/dir"
                    if "Artifacts at " in text:
                        try:
                            # Extract path (assuming it's the last part or clearly delimited)
                            # Simple heuristic: split by "Artifacts at " and take the rest of the line
                            parts = text.split("Artifacts at ")
                            if len(parts) > 1:
                                path_part = parts[1].split(".")[0].strip() # Stop at dot if present
                                if os.path.exists(path_part) and os.path.isdir(path_part):
                                    files = os.listdir(path_part)
                                    # Filter for relevant files (skip hidden, etc.)
                                    visible_files = [f for f in files if not f.startswith('.')]
                                    if visible_files:
                                        note_lines.append(f"  - Files in {os.path.basename(path_part)}: {', '.join(visible_files)}")
                        except Exception as e:
                            print(f"Error listing artifacts: {e}", file=sys.stderr)

                if note_lines:
                    lines.append("Relevant project notes:\n" + "\n".join(note_lines))
            
            if lines:
                ctx_summary = "\n\n### Context from memory\n" + "\n".join(lines) + "\n\n"
    except Exception as e:
        print(f"Error parsing ADK_CONTEXT: {e}", file=sys.stderr)
        ctx_summary = ""

    # ============================================================================
    # AGENT 0: BUSINESS ANALYST (Analyzes and clarifies requirements)
    # ============================================================================
    ba_agent = LlmAgent(
        name="BusinessAnalystAgent",
        model=LLM_MODEL,
        instruction=f"""You are a SENIOR BUSINESS ANALYST specializing in translating user requests into detailed technical requirements.

**Your Task:**
Analyze the user's request and create a comprehensive requirements document that will guide the development team.

**User Request:**
{user_message}

**Context:** {ctx_summary}

**Analysis Framework:**

1. **Requirements Clarification:**
   - What is the core functionality requested?
   - What are the implicit requirements not explicitly stated?
   - What assumptions should we make?
   - Are there any ambiguities that need clarification?

2. **Technical Specifications:**
   - Project type (React app, Vue dashboard, Python API, etc.)
   - Key features and functionalities
   - Technology stack recommendations
   - Architecture patterns to use
   - External dependencies or APIs needed

3. **Scope Definition:**
   - Must-have features (MVP)
   - Nice-to-have features
   - Out of scope items
   - Estimated complexity (Simple/Medium/Complex)

4. **Success Criteria:**
   - How do we know the project is complete?
   - What should the user be able to do?
   - Performance expectations
   - Quality standards

5. **Risk Assessment:**
   - Potential technical challenges
   - Dependencies that might cause issues
   - Areas that need extra attention

**Output Format:**
Provide a structured requirements document in markdown:

# Project Requirements Analysis

## 📋 Project Overview
[Brief description]

## 🎯 Core Requirements
[List of must-have features]

## 🛠️ Technical Stack
[Recommended technologies and why]

## 📐 Architecture
[High-level architecture and patterns]

## ✅ Success Criteria
[How to measure success]

## ⚠️ Risks & Considerations
[Potential issues to watch for]

## 📦 Deliverables
[What files/folders should be created]

Be thorough but concise. This document will guide the code generation process.
""",
        description="Analyzes user requirements and creates detailed technical specifications",
        output_key="requirements_analysis"
    )

    # ============================================================================
    # AGENT 1: CODE WRITER (No tools - just generates code as text)
    # ============================================================================
    # code_writer_agent = LlmAgent(
    #     name="CodeWriterAgent",
    #     model=LLM_MODEL,
    #     instruction=f"""You are a senior software engineer specializing in project scaffolding and code generation.{ctx_summary}

    # **Your Task:**
    # Generate a complete, runnable Python script that fulfills the user's request by programmatically creating files and folders, leveraging the provided memory context when relevant.

    # **Target Directory:** {TARGET_FOLDER_PATH}

    # **IMPORTANT: Start your response with a detailed analysis section:**
    
    # ## 📋 Problem Analysis
    # [Provide detailed reasoning about what the user wants to build, key requirements, and technical considerations]
    
    # ## 🎯 Approach
    # [Explain your step-by-step approach to solve this problem, including:
    # - Project structure design
    # - Technology choices and why
    # - Key components and their purposes
    # - Implementation strategy]
    
    # ## 💡 Key Code Snippets
    # [Highlight 2-3 important code patterns or configurations that make this solution work]
    
    # ## 🚀 How to Run
    # [Provide clear, step-by-step instructions on how to run the generated project:
    # 1. Navigate to the project directory
    # 2. Install dependencies (with exact commands)
    # 3. Run the application (with exact commands)
    # 4. Access the application (URLs, ports, etc.)]
    
    # ---
    
    # **Then, generate the complete Python script:**

    # **Guidelines:**
    # 1. **Understand the Request:** Carefully analyze what the user wants to build

    # 2. **Generate Complete Code:** Create a fully working Python script with:
    # - Proper imports (os, subprocess, pathlib, json, etc.)
    # - Clear variable definitions
    # - Step-by-step logic to create project structure
    # - File creation with appropriate content
    # - Comprehensive error handling with try-except blocks
    # - Progress logging with descriptive print statements
    
    # 3. **Project Structure Best Practices:**
    # - For React apps: Create manual structure (don't rely on create-react-app in generated code)
    # - For Python projects: Create proper package structure with __init__.py files
    # - Include README.md, .gitignore, package.json, and other standard files
    # - Generate actual working code content, not placeholders or TODOs
    
    # 4. **File Operations:**
    # - Use absolute paths: `os.path.join("{TARGET_FOLDER_PATH}", ...)`
    # - Create directories: `os.makedirs(path, exist_ok=True)`
    # - Write files with: `with open(path, 'w', encoding='utf-8') as f:`
    # - Wrap all file operations in try-except blocks
    
    # 5. **Code Structure Requirements:**
    # ```python
    # #!/usr/bin/env python3
    # \"\"\"
    # Script to create [project description]
    # Generated by CodeWriterAgent
    # \"\"\"
    # import os
    # import json
    # from pathlib import Path
    
    # def main():
    #     base_path = "{TARGET_FOLDER_PATH}"
    #     project_name = "your-project-name"
    #     project_path = os.path.join(base_path, project_name)
        
    #     try:
    #         # Create directories
    #         print(f"Creating project at: project_path")
    #         os.makedirs(project_path, exist_ok=True)
            
    #         # Create files with actual content
    #         # ... your code here
            
    #         print("✓ Project created successfully!")
    #         return True
    #     except Exception as e:
    #         print(f"✗ Error creating project: e")
    #         return False
    
    # if __name__ == "__main__":
    #     main()
    # ```

    # 6. **For React Projects - Manual Setup:**
    # Create the following structure manually:
    # - package.json with dependencies (react, react-dom, react-scripts)
    # - public/index.html
    # - src/index.js, src/App.js, src/App.css
    # - .gitignore
    # - README.md

    # **Output Format:**
    # First provide the analysis sections (Problem Analysis, Approach, Key Code Snippets, How to Run), then output the complete Python code.
    # """,
    #     description="Generates complete Python code for project creation with detailed reasoning",
    #     output_key="generated_code"
    # )

    code_writer_agent = LlmAgent(
        name="CodeWriterAgent",
        model=LLM_MODEL,
        instruction=f"""You are a SENIOR FULL-STACK SOFTWARE ENGINEER specializing in production-ready project scaffolding.

**CRITICAL MISSION:** Generate a complete, immediately executable Python script that creates a FULLY FUNCTIONAL, PRODUCTION-READY project.

**Requirements Analysis:**
{{{{requirements_analysis}}}}

**Target Directory:** {TARGET_FOLDER_PATH}

**ABSOLUTE REQUIREMENTS:**

1. **CODE MUST WORK OUT OF THE BOX**
   - Generate COMPLETE implementations, not stubs or TODOs
   - Use MODERN, STABLE package versions (e.g., React 18+, Vue 3+, latest LTS)
   - Include ALL necessary configuration files
   - Every component must be fully implemented with real functionality

2. **PROJECT-SPECIFIC STANDARDS:**

   **For React Projects:**
   - Use React 18+ with modern hooks (useState, useEffect, useContext)
   - Include routing (react-router-dom v6+)
   - Add state management if needed (Context API or Redux Toolkit)
   - Create multiple working components (Layout, Header, Footer, main views)
   - Include actual data fetching examples
   - Use modern CSS (Tailwind CSS or CSS Modules)
   - Generate working package.json with proper scripts
   - Create .env.example for environment variables
   
   **For Vue Projects:**
   - Use Vue 3 with Composition API
   - Include Vue Router 4+
   - Add Pinia for state management
   - Create multiple working components with <script setup>
   - Include actual API integration examples
   - Use Vite for build tooling
   - Generate proper vite.config.js
   - Create complete main.js and App.vue
   
   **For Node.js/Express APIs:**
   - Use Express 4+ with async/await
   - Include proper middleware (cors, helmet, morgan)
   - Create multiple working routes (CRUD operations)
   - Add input validation (express-validator)
   - Include error handling middleware
   - Generate .env.example with all required variables
   - Create proper package.json with all dependencies
   
   **For Python Projects:**
   - Use modern Python 3.10+ features
   - Include requirements.txt with specific versions
   - Create proper package structure with __init__.py
   - Add working examples of main functionality
   - Include .env.example and config.py
   - Generate setup.py for distribution

3. **MANDATORY FILES FOR ALL PROJECTS:**
   - README.md with complete setup instructions
   - .gitignore appropriate for the tech stack
   - .env.example with all environment variables
   - package.json/requirements.txt with SPECIFIC versions
   - Configuration files (vite.config.js, tsconfig.json, etc.)

4. **CODE QUALITY STANDARDS:**
   - NO placeholder comments like "Add your code here"
   - NO TODO items in the generated code
   - ALL functions must have implementations
   - ALL imports must be correct and complete
   - USE proper error handling everywhere
   - ADD helpful comments explaining complex logic

5. **SPECIFIC VERSION REQUIREMENTS:**
   ```json
   React ecosystem:
   - "react": "^18.2.0"
   - "react-dom": "^18.2.0"
   - "react-router-dom": "^6.20.0"
   - "react-scripts": "5.0.1" OR use Vite
   
   Vue ecosystem:
   - "vue": "^3.3.0"
   - "vue-router": "^4.2.0"
   - "pinia": "^2.1.0"
   - "vite": "^5.0.0"
   
   Express:
   - "express": "^4.18.0"
   - "cors": "^2.8.5"
   - "dotenv": "^16.0.0"
   - "helmet": "^7.1.0"
   ```

6. **PYTHON SCRIPT STRUCTURE:**
   ```python
   #!/usr/bin/env python3
   import os
   import json
   from pathlib import Path
   
   def create_file(path, content):
       try:
           os.makedirs(os.path.dirname(path), exist_ok=True)
           with open(path, 'w', encoding='utf-8') as f:
               f.write(content)
           print("✓ Created: " + path)
       except Exception as e:
           print("✗ Error creating " + path + ": " + str(e))
   
   def main():
       base_path = "{TARGET_FOLDER_PATH}"
       project_name = "project-name"
       project_path = os.path.join(base_path, project_name)
       
       print("Creating " + project_name + " at: " + project_path)
       
       # Create all directories (replace with real lists; do not use ellipses)
       # dirs = ["src", "public", "src/components", "src/pages"]
       # for d in dirs:
       #     os.makedirs(os.path.join(project_path, d), exist_ok=True)
       
       # Example: create package.json (replace with real JSON)
       # create_file(
       #     os.path.join(project_path, "package.json"),
       #     json.dumps({{"name": project_name, "version": "0.1.0"}}, indent=2)
       # )
       
       print("✓ Project created successfully!")
       print("\nNext steps:")
       print("1. cd " + project_path)
       print("2. npm install")
       print("3. npm run dev")
   
   if __name__ == "__main__":
       main()
   ```

**CRITICAL SUCCESS FACTORS:**
- User should be able to `npm install && npm run dev` immediately
- Project should open without errors
- All routes/pages should work
- No console errors
- Looks professional (not bare-bones)

**OUTPUT:** Pure Python code ONLY and you MUST NOT include any three double quotes comments, No markdown, no explanations. Code must be ready to save as output.py and execute immediately

**Code Template:**
```python
#!/usr/bin/env python3
import os
import json
from pathlib import Path

def main():
    base_path = "{TARGET_FOLDER_PATH}"
    project_name = "your-project-name"
    project_path = os.path.join(base_path, project_name)
    
    try:
        print("Creating project at: " + project_path)
        os.makedirs(project_path, exist_ok=True)
        
        # Create files with actual content here
        
        print("✓ Project created successfully!")
        return True
    except Exception as e:
        print("✗ Error: " + str(e))
        return False

if __name__ == "__main__":
    main()
```

**For Different Project Types:**

- **Web Apps** (React, Vue, Flask, Django): Include complete scaffolding with HTML, JS, CSS, configs, README.md, .gitignore
- **Data/ML Projects**: Include data/, notebooks/, src/, models/ folders with working scripts
- **Backend APIs**: Include proper API structure with routes, middleware, error handling
- **CLI Tools**: Include functional main with argparse/click, setup.py, documentation
- **General Projects**: Organized folder hierarchy with complete, working code

**REMEMBER:** Generate COMPLETE, production-ready Python code that works immediately. NO placeholders, NO TODOs.
    """,
        description="Generates full Python code that builds complete project structures for any domain",
        output_key="generated_code"
    )


    # ============================================================================
    # AGENT 2: CODE REVIEWER (No tools needed - just reviews text)
    # ============================================================================
    code_reviewer_agent = LlmAgent(
        name="CodeReviewerAgent",
        model=LLM_MODEL,
        instruction="""You are a SENIOR CODE REVIEWER with ZERO tolerance for incomplete or non-production-ready code.

    **Your Task:**
    Review the generated Python code with EXTREME scrutiny for production readiness.

    **Code to Review:**
    {generated_code}

    **STRICT REVIEW CHECKLIST:**

    1. **REJECT IF ANY OF THESE EXIST:**
       - TODO comments
       - "Add your code here" comments
       - Placeholder text or stub functions
       - Empty component implementations
       - Missing function bodies
       - Comments like "implement this later"
       - Outdated package versions (React < 18, Vue < 3, etc.)
       - Generic/vague configuration
       - Unclosed strings or unmatched quotes
       - Undefined variables or references (e.g., using a variable before assignment)
       - Syntax errors detectable by basic inspection (e.g., missing commas/colons)

    2. **Package Version Requirements:**
       - React projects MUST use React 18+ ("react": "^18.2.0")
       - Vue projects MUST use Vue 3+ ("vue": "^3.3.0")
       - Vue projects MUST use Vite ("vite": "^5.0.0"), NOT vue-cli
       - Express projects MUST use Express 4.18+ ("express": "^4.18.0")
       - REJECT if using Vue CLI or create-react-app without Vite
       - REJECT if using old versions (Vue 2, React 17, etc.)

    3. **Configuration File Validation:**
       - package.json MUST have: name, version, scripts, dependencies
       - package.json scripts MUST include: dev, build, preview/start
       - For Vue: MUST have vite.config.js (NOT vue.config.js)
       - For React with Vite: MUST have vite.config.js
       - index.html MUST NOT use <%= BASE_URL %> (that's Vue CLI syntax)
       - index.html MUST use proper Vite syntax or relative paths

    4. **Component Completeness:**
       - ALL components must have full implementations
       - Components must have actual JSX/template content (not empty)
       - Components must include real functionality (state, effects, handlers)
       - NO placeholder text like "Content goes here"
       - Must include multiple pages/views (Home, About, Dashboard, etc.)

    5. **Functionality Requirements:**
       - Must include routing (React Router or Vue Router)
       - Must include actual data examples (mock data is OK)
       - Must include working navigation
       - Must include styled components (actual CSS, not empty)
       - For dashboards: Must include cards, charts, or data display

    6. **File Structure:**
       - Must have proper directory structure (src/, public/, components/)
       - Must include README.md with complete setup instructions
       - Must include .gitignore
       - Must include .env.example if env vars are used
       - Configuration files must be present (vite.config.js, etc.)

    7. **Code Quality:**
       - All imports must be present and correct
       - No syntax errors in JavaScript/JSX
       - Proper error handling in Python script
       - Clear variable names
       - Helpful comments (but NO TODOs)

    **CRITICAL: Be EXTREMELY STRICT**
    - If you find even ONE TODO, REJECT
    - If you find outdated versions, REJECT
    - If you find incomplete implementations, REJECT
    - If you find placeholder comments, REJECT
    - If configuration is wrong (BASE_URL, old Vue CLI), REJECT

    **Output Format:**
    - If code is PERFECT and production-ready: "APPROVED: Code is production-ready and ready to save."
    - If ANY issues exist:
    ```
    ISSUES FOUND:
    - index.html uses <%= BASE_URL %> which is specific to vue-cli and might not work without vue-cli. It should be replaced with a proper relative path or a public URL.
    - The Vue CLI service version in package.json is quite old (4.5.0). Consider updating it to a more recent stable version, or removing it if the project is not intended to use Vue CLI.
    - The created dashboard is very basic. While it fulfills the request, it lacks actual dashboard components or layout. More advanced components and a dashboard layout should be implemented to make it a functional dashboard.
    - The App.vue component and routing are minimal. It only includes links to "Home" and "About". Consider adding a default route or a dashboard view.
    - TODO found in App.js at line 15: "Add authentication logic"
    - package.json uses outdated React version (17.0.2), must be 18.2.0+
    - Component Home.jsx is empty with only placeholder text
    [List EVERY specific issue found]
    ```

    Be RUTHLESS. Only approve PERFECT, production-ready code.
    """,
        description="Strictly reviews generated code for production readiness",
        output_key="review_comments"
    )

    # ============================================================================
    # AGENT 3: CODE REFACTORER (No tools - just refactors text)
    # ============================================================================
    code_refactorer_agent = LlmAgent(
        name="CodeRefactorerAgent",
        model=LLM_MODEL,
        instruction=f"""You are a Python refactoring expert.

    **Your Task:**
    Refactor the code based on reviewer feedback to make it production-ready.

    **Original Code:**
    {{generated_code}}

    **Reviewer Feedback:**
    {{review_comments}}

    **Instructions:**

    1. **If Approved (starts with "APPROVED"):** 
    - Keep the code exactly as-is, no changes needed
    
    2. **If Issues Found:**
    - Address EVERY specific issue mentioned
    - Remove ALL placeholder comments and TODOs
    - Add comprehensive error handling
    - Ensure all files have actual, working content
    - Add docstrings and helpful comments
    - Improve code structure and organization
    
    3. **Refactoring Checklist:**
    - ✓ Add module-level docstring
    - ✓ Create main() function
    - ✓ Add if __name__ == "__main__": guard
    - ✓ Wrap all file operations in try-except
    - ✓ Use descriptive variable names
    - ✓ Add progress logging (print statements)
    - ✓ Ensure all content is complete (no placeholders)
    - ✓ For React: Full working components with JSX
    - ✓ For configs: Complete, valid JSON/YAML
    
    4. **Quality Standards:**
    - Every file created must have real, working content
    - No "// Add your code here" comments
    - No "TODO" items left in the code
    - All dependencies in package.json must be specified
    - All imports must be at the top
    
    **Output Format:**
    Output ONLY the complete, refactored Python code. No explanations, no markdown, just the raw Python code ready to be saved.

    The code should be immediately executable and create a fully functional project.
    """,
        description="Refactors code based on feedback to ensure production quality",
        output_key="refactored_code"
    )

    # ============================================================================
    # AGENT 4: FILE SAVER (Uses MCP tools to save the file)
    # ============================================================================
    file_saver_agent = LlmAgent(
        name="FileSaverAgent",
        model=LLM_MODEL,
        tools=[filesystem_toolset],
        instruction=f"""You are a file management specialist with access to filesystem tools.

    **Your Task:**
    Save the final Python script to disk using the write_file tool.

    **Final Code to Save:**
    {{refactored_code}}

    **Instructions:**
    1. Extract ONLY the Python code section (everything after the analysis sections)
    2. Use the `write_file` tool to save the code
    3. Filename: `output.py`
    4. Full path: `{SCRIPT}`
    5. Content: The complete refactored Python code (without the markdown analysis sections)

    **CRITICAL:**
    - You MUST call the write_file tool
    - Save ONLY the Python code, not the analysis sections
    - Verify the save was successful

    **After saving:**
    Report: "✓ Successfully saved output.py to {TARGET_FOLDER_PATH}"

    If there's an error saving, report: "✗ Error saving file: [error details]
    """,
        description="Saves the final Python script to output.py using filesystem tools",
        output_key="save_status"
    )

    # ============================================================================
    # AGENT 5: TESTING & VALIDATION AGENT (Validates and tests the generated project)
    # ============================================================================
    testing_agent = LlmAgent(
        name="TestingAgent",
        model=LLM_MODEL,
        tools=[filesystem_toolset],
        instruction=f"""You are a QA ENGINEER specializing in validation and testing of generated projects.

**Your Task:**
Validate that output.py was saved correctly and test the generated project for completeness and correctness.

**Validation Steps:**

1. **File Verification:**
   - Confirm output.py exists at {SCRIPT}
   - Use read_file tool to verify the content
   - Check file size is reasonable (not empty, not truncated)
   - Verify Python syntax is valid

2. **Code Quality Checks:**
   - No TODO comments in the generated code
   - All imports are present
   - All functions have implementations
   - No placeholder text like "Add your code here"
   - Proper error handling exists

3. **Project Structure Validation:**
   - Analyze what the script will create
   - Verify all necessary files will be generated (package.json, README, etc.)
   - Check that file paths are correct and absolute
   - Ensure directory creation logic is sound

4. **Technology-Specific Checks:**
   - For React/Vue: Verify package.json has all dependencies
   - For Python: Check requirements.txt exists
   - For all: Verify .gitignore is appropriate
   - For all: Confirm README has setup instructions

5. **Execution Safety:**
   - Check for any potentially harmful operations
   - Verify paths are within {TARGET_FOLDER_PATH}
   - Confirm no hardcoded credentials or secrets

**Output Format:**

```
# Validation Report

## ✅ Passed Checks
- [List all checks that passed]

## ❌ Failed Checks (if any)
- [List any issues found]

## 📊 Summary
- Total checks: X
- Passed: Y
- Failed: Z
- Status: PASS/FAIL

## 🎯 Recommendations
- [Any suggestions for improvement]

## 🚀 Next Steps
[What the user should do next to use the generated project]
```

Be thorough and critical. If you find any issues, clearly explain what's wrong and why it matters.
""",
        description="Validates and tests the generated project for completeness and correctness",
        output_key="test_results"
    )



    # ============================================================================
    # COMPOSITE AGENTS
    # ============================================================================

    # Loop for iterative improvement (Review -> Refactor)
    code_improvement_loop = LoopAgent(
        name="CodeImprovementLoop",
        sub_agents=[code_reviewer_agent, code_refactorer_agent],
        max_iterations=1,  # Reduced from 3 to 1 for faster execution
        description="Reviews and refactors code once for quality assurance"
    )


        
    code_pipeline_agent = SequentialAgent(
        name="FullPipelineAgent",
        sub_agents=[
            ba_agent,              # 1. Analyze requirements
            code_writer_agent,     # 2. Generate code
            code_improvement_loop, # 3. Review & refactor
            file_saver_agent,      # 4. Save to disk
            testing_agent,         # 5. Validate & test
        ],
        description="Complete pipeline: analyzes requirements, generates code, improves it, saves it, and validates the result",
    )

    # ============================================================================
    # ROOT AGENT
    # ============================================================================
    root_agent = code_pipeline_agent

    runner = Runner(
        agent=root_agent,
        app_name="node_adk_bridge",
        session_service=session_service,
    )

    # Prepare user message
    message = genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=user_message)],
    )

    outputs = []
    current_agent = None

    # Emit initial pipeline start
    emit_event("pipeline.start", {"message": "Starting ADK pipeline"})
    
    # Emit agent sequence
    agents_sequence = [
        {"name": "BusinessAnalystAgent", "description": "Analyzing requirements and creating specifications"},
        {"name": "CodeWriterAgent", "description": "Generating production-ready code"},
        {"name": "CodeReviewerAgent", "description": "Reviewing code quality"},
        {"name": "CodeRefactorerAgent", "description": "Refactoring and improving code"},
        {"name": "SyntaxValidatorAgent", "description": "Validating Python syntax"},
        {"name": "FileSaverAgent", "description": "Saving files to disk"},
        {"name": "ProjectExecutorAgent", "description": "Executing output.py and creating project"},
        {"name": "TestingAgent", "description": "Validating and testing the generated project"},
    ]
    
    agent_index = 0

    # Run the pipeline
    try:
        async for event in runner.run_async(
            user_id="node_user",
            session_id="adk_session",
            new_message=message,
        ):
            # Detect agent transitions by checking event type and content
            event_type = type(event).__name__
            
            # Emit agent start for each step
            if event_type in ["AgentStartEvent", "AgentThinkingEvent"] or (hasattr(event, 'content') and event.content):
                if agent_index < len(agents_sequence):
                    agent_info = agents_sequence[agent_index]
                    if current_agent != agent_info["name"]:
                        current_agent = agent_info["name"]
                        emit_event("agent.start", {
                            "agent": agent_info["name"],
                            "description": agent_info["description"],
                            "timestamp": None
                        })
            
            # Detect tool usage from function calls in event
            if hasattr(event, 'function_calls') and event.function_calls:
                for func_call in event.function_calls:
                    # Try multiple attributes for tool name
                    tool_name = (
                        getattr(func_call, 'name', None) or
                        getattr(func_call, 'function_name', None) or
                        getattr(func_call, 'tool_name', None) or
                        str(type(func_call).__name__)
                    )
                    if not tool_name or tool_name == 'NoneType':
                        tool_name = 'write_file'  # Default for filesystem operations
                    emit_event("tool.use", {
                        "agent": current_agent or "Unknown",
                        "tool": tool_name,
                        "timestamp": None
                    })
            
            # Check for tool calls in content parts
            if hasattr(event, 'content') and hasattr(event.content, 'parts'):
                for part in event.content.parts:
                    if hasattr(part, 'function_call'):
                        fc = part.function_call
                        tool_name = (
                            getattr(fc, 'name', None) or
                            getattr(fc, 'function_name', None) or
                            str(type(fc).__name__)
                        )
                        if not tool_name or tool_name == 'NoneType':
                            tool_name = 'write_file'
                        emit_event("tool.use", {
                            "agent": current_agent or "Unknown",
                            "tool": tool_name,
                            "timestamp": None
                        })
            
            # Collect final outputs
            if event.is_final_response() and hasattr(event.content, "parts"):
                for part in event.content.parts:
                    if hasattr(part, "text"):
                        outputs.append(part.text)
                        agent_index += 1  # Move to next agent after response
    except Exception as e:
        # Return a single-element outputs array with a readable error
        err_msg = str(e)
        emit_event("pipeline.error", {"error": err_msg})
        return [f"ADK error: {err_msg}"]

    # Process outputs to extract only the analysis sections (not the Python code)
    processed_outputs = []
    for output in outputs:
        # Split by common code markers
        if "```python" in output:
            # Extract only the part before the Python code block
            parts = output.split("```python")
            analysis_section = parts[0].strip()
            if analysis_section:
                processed_outputs.append(analysis_section)
        elif "#!/usr/bin/env python" in output:
            # Extract only the part before the shebang
            parts = output.split("#!/usr/bin/env python")
            analysis_section = parts[0].strip()
            if analysis_section:
                processed_outputs.append(analysis_section)
        else:
            # If no code detected, include the whole output
            processed_outputs.append(output)
    
    
    # Emit pipeline completion event
    emit_event("pipeline.complete", {"message": "ADK pipeline completed successfully"})
    
    # Emit final 'complete' event that frontend expects to close the stream
    final_outputs = processed_outputs if processed_outputs else outputs
    emit_event("complete", {
        "outputs": final_outputs,
        "projectPath": f"{TARGET_FOLDER_PATH}",
        "status": "success"
    })
    
    # CRITICAL: Also print to stdout for Node.js agentService to parse
    # Node.js reads from stdout buffer to get final results
    print(json.dumps(final_outputs), flush=True)
    
    return final_outputs


def run_pipeline(user_message: str):
    """Entry point that runs the async ADK pipeline synchronously."""
    return asyncio.run(run_pipeline_async(user_message))


if __name__ == "__main__":
    msg = sys.argv[1] if len(sys.argv) > 1 else "Help me create something new"
    run_pipeline(msg)
