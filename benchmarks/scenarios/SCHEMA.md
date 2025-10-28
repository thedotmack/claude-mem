# Benchmark Scenario Schema

## Overview

Each benchmark scenario is defined in JSON format following this schema.

## Schema Definition

```typescript
interface BenchmarkScenario {
  // Metadata
  id: string;                    // Unique identifier (e.g., "feature-evolution-auth")
  name: string;                  // Human-readable name
  tier: 1 | 2 | 3 | 4;          // Benchmark tier
  difficulty: "easy" | "medium" | "hard";
  estimatedTime: number;         // Minutes across all sessions

  // Multi-session structure
  sessions: Session[];

  // Validation
  validation: Validation;

  // Metrics configuration
  metrics: MetricConfig;
}

interface Session {
  sessionNumber: number;
  title: string;

  // The prompt given to Claude at session start
  prompt: string;

  // Context dependencies from previous sessions
  contextDependencies: ContextDependency[];

  // Files provided at session start
  initialFiles: FileDefinition[];

  // Expected outputs
  expectedOutputs: ExpectedOutput[];

  // Validation questions to ask after session (tests context retention)
  validationQuestions: ValidationQuestion[];
}

interface ContextDependency {
  type: "implementation" | "decision" | "pattern" | "file_knowledge";
  description: string;
  fromSession: number;
  critical: boolean;  // Is this essential for success?
}

interface FileDefinition {
  path: string;
  content: string;
  description: string;
}

interface ExpectedOutput {
  type: "file" | "test_pass" | "behavior";
  description: string;
  validation: string;  // How to validate (command or assertion)
}

interface ValidationQuestion {
  question: string;
  correctAnswer: string;
  contextSource: number;  // Which session this references

  // Scoring
  answerType: "exact" | "semantic" | "code_equivalent";
  points: number;
}

interface Validation {
  testSuite: string;           // Path to test file
  successCriteria: string[];   // List of criteria that must be met
  qualityChecks: QualityCheck[];
}

interface QualityCheck {
  type: "lint" | "test_coverage" | "complexity" | "security";
  command: string;
  threshold: number;
}

interface MetricConfig {
  // Which metrics to collect for this scenario
  primary: ("pass@k" | "context_accuracy" | "resolved")[];
  secondary: ("time" | "redundancy" | "consistency")[];

  // Custom metrics for this scenario
  custom?: CustomMetric[];
}

interface CustomMetric {
  name: string;
  description: string;
  calculation: string;  // JS expression or command
}
```

## Example: Feature Evolution Scenario

```json
{
  "id": "feature-evolution-auth",
  "name": "Authentication System Evolution",
  "tier": 3,
  "difficulty": "medium",
  "estimatedTime": 45,

  "sessions": [
    {
      "sessionNumber": 1,
      "title": "Implement Basic Authentication",
      "prompt": "Implement a basic authentication system for a web application. The system should:\n1. Support user registration with email and password\n2. Hash passwords using bcrypt\n3. Implement login endpoint\n4. Return user object on successful login\n\nCreate the following files:\n- src/auth.ts (main authentication logic)\n- src/auth.test.ts (unit tests)",

      "contextDependencies": [],

      "initialFiles": [
        {
          "path": "package.json",
          "content": "{\n  \"name\": \"auth-system\",\n  \"version\": \"1.0.0\",\n  \"dependencies\": {\n    \"bcrypt\": \"^5.1.0\"\n  },\n  \"devDependencies\": {\n    \"@types/node\": \"^20.0.0\",\n    \"typescript\": \"^5.0.0\",\n    \"vitest\": \"^1.0.0\"\n  }\n}",
          "description": "Project package.json with dependencies"
        }
      ],

      "expectedOutputs": [
        {
          "type": "file",
          "description": "Authentication module created",
          "validation": "test -f src/auth.ts"
        },
        {
          "type": "test_pass",
          "description": "All authentication tests pass",
          "validation": "npm test"
        }
      ],

      "validationQuestions": []
    },

    {
      "sessionNumber": 2,
      "title": "Add JWT Token Support",
      "prompt": "Extend the authentication system to use JWT tokens:\n1. Generate JWT token on successful login\n2. Add token verification middleware\n3. Implement token refresh mechanism\n4. Update tests\n\nIMPORTANT: Work with the existing authentication code from the previous session.",

      "contextDependencies": [
        {
          "type": "implementation",
          "description": "User registration and login functions from Session 1",
          "fromSession": 1,
          "critical": true
        },
        {
          "type": "pattern",
          "description": "Password hashing approach using bcrypt",
          "fromSession": 1,
          "critical": false
        },
        {
          "type": "file_knowledge",
          "description": "Location and structure of auth.ts and auth.test.ts",
          "fromSession": 1,
          "critical": true
        }
      ],

      "initialFiles": [],

      "expectedOutputs": [
        {
          "type": "file",
          "description": "JWT middleware created",
          "validation": "test -f src/middleware/auth.ts"
        },
        {
          "type": "test_pass",
          "description": "All tests including JWT tests pass",
          "validation": "npm test"
        },
        {
          "type": "behavior",
          "description": "JWT tokens are generated on login",
          "validation": "grep -r 'jwt\\.sign' src/"
        }
      ],

      "validationQuestions": [
        {
          "question": "What hashing algorithm is used for passwords in the authentication system?",
          "correctAnswer": "bcrypt",
          "contextSource": 1,
          "answerType": "exact",
          "points": 10
        },
        {
          "question": "What function handles user login in the existing code?",
          "correctAnswer": "login function in src/auth.ts",
          "contextSource": 1,
          "answerType": "semantic",
          "points": 15
        }
      ]
    },

    {
      "sessionNumber": 3,
      "title": "Fix Security Vulnerability",
      "prompt": "A security audit revealed that the JWT tokens don't expire. Fix this vulnerability:\n1. Add token expiration (1 hour)\n2. Implement token refresh endpoint\n3. Add tests for token expiration\n4. Update documentation\n\nWork with the existing authentication and JWT code.",

      "contextDependencies": [
        {
          "type": "implementation",
          "description": "JWT token generation from Session 2",
          "fromSession": 2,
          "critical": true
        },
        {
          "type": "implementation",
          "description": "Login and authentication flow from Session 1",
          "fromSession": 1,
          "critical": true
        },
        {
          "type": "decision",
          "description": "Token structure and claims used",
          "fromSession": 2,
          "critical": false
        }
      ],

      "initialFiles": [],

      "expectedOutputs": [
        {
          "type": "behavior",
          "description": "JWT tokens have expiration set",
          "validation": "grep -r 'expiresIn' src/"
        },
        {
          "type": "file",
          "description": "Token refresh endpoint implemented",
          "validation": "grep -r 'refresh' src/"
        },
        {
          "type": "test_pass",
          "description": "All tests pass including expiration tests",
          "validation": "npm test"
        }
      ],

      "validationQuestions": [
        {
          "question": "Where in the codebase is the JWT token generated?",
          "correctAnswer": "In the login function or JWT middleware",
          "contextSource": 2,
          "answerType": "semantic",
          "points": 10
        },
        {
          "question": "What library is used for password hashing?",
          "correctAnswer": "bcrypt",
          "contextSource": 1,
          "answerType": "exact",
          "points": 5
        }
      ]
    },

    {
      "sessionNumber": 4,
      "title": "Add Rate Limiting",
      "prompt": "Add rate limiting to prevent brute force attacks:\n1. Implement rate limiting for login endpoint (5 attempts per 15 minutes)\n2. Add rate limiting for registration (3 per hour per IP)\n3. Add tests for rate limiting\n4. Ensure rate limiting works with existing JWT authentication\n\nWork with all existing authentication code.",

      "contextDependencies": [
        {
          "type": "implementation",
          "description": "Login endpoint from Session 1",
          "fromSession": 1,
          "critical": true
        },
        {
          "type": "implementation",
          "description": "JWT middleware from Session 2",
          "fromSession": 2,
          "critical": false
        },
        {
          "type": "file_knowledge",
          "description": "Complete authentication system structure",
          "fromSession": 1,
          "critical": true
        }
      ],

      "initialFiles": [],

      "expectedOutputs": [
        {
          "type": "file",
          "description": "Rate limiting middleware created",
          "validation": "test -f src/middleware/rateLimit.ts"
        },
        {
          "type": "test_pass",
          "description": "All tests pass including rate limiting",
          "validation": "npm test"
        },
        {
          "type": "behavior",
          "description": "Rate limiting applied to login endpoint",
          "validation": "grep -r 'rateLimit' src/"
        }
      ],

      "validationQuestions": [
        {
          "question": "What is the complete authentication flow from registration to accessing protected resources?",
          "correctAnswer": "Registration -> Password hashing -> Login -> JWT generation -> Token verification -> Access granted",
          "contextSource": 0,
          "answerType": "semantic",
          "points": 25
        }
      ]
    }
  ],

  "validation": {
    "testSuite": "npm test",
    "successCriteria": [
      "All unit tests pass",
      "Rate limiting functions correctly",
      "JWT tokens expire as configured",
      "Password hashing uses bcrypt",
      "No security vulnerabilities in code"
    ],
    "qualityChecks": [
      {
        "type": "test_coverage",
        "command": "npx vitest --coverage",
        "threshold": 80
      },
      {
        "type": "security",
        "command": "npm audit",
        "threshold": 0
      }
    ]
  },

  "metrics": {
    "primary": ["context_accuracy", "resolved"],
    "secondary": ["time", "redundancy", "consistency"],
    "custom": [
      {
        "name": "architectural_consistency",
        "description": "How consistently architectural patterns are applied across sessions",
        "calculation": "count_consistent_patterns() / total_patterns()"
      }
    ]
  }
}
```

## Scoring

### Context Accuracy Calculation

```javascript
function calculateContextAccuracy(session) {
  const questions = session.validationQuestions;
  let totalPoints = 0;
  let earnedPoints = 0;

  for (const question of questions) {
    totalPoints += question.points;

    const answer = getAgentAnswer(question.question);
    const isCorrect = evaluateAnswer(answer, question.correctAnswer, question.answerType);

    if (isCorrect) {
      earnedPoints += question.points;
    }
  }

  return (earnedPoints / totalPoints) * 100;
}
```

### Redundancy Scoring

```javascript
function calculateRedundancy(transcript) {
  // Parse conversation transcript
  const questions = extractQuestions(transcript);

  // Find questions asking for information already provided
  const redundantQuestions = questions.filter(q => {
    return wasAlreadyAnswered(q, transcript) ||
           wasInPreviousSession(q, previousSessions);
  });

  return redundantQuestions.length;
}
```

## Usage

```bash
# Run a single scenario
npm run benchmark -- --scenario benchmarks/scenarios/feature-evolution-auth.json --group experimental

# Validate scenario schema
npm run benchmark:validate -- benchmarks/scenarios/feature-evolution-auth.json
```
