# Contributing to DeepChat

We love your input! We want to make contributing to DeepChat as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features
- Becoming a maintainer

## Development Process

We use GitHub to host code, to track issues and feature requests, as well as accept pull requests.

### Internal Team Contributors

#### Bug Fixes and Minor Feature Improvements

- Develop directly on the `dev` branch
- Code submitted to the `dev` branch must ensure:
  - Basic functionality works
  - No compilation errors
  - Project can start normally with `npm run dev`

#### Major Features or Refactoring

- Create a new feature branch named `feature/featurename`
- Merge the feature branch back to `dev` branch upon completion

### External Contributors

1. Fork this repository to your personal account
2. Create your development branch from `dev`
3. Develop in your forked repository
4. Submit a Pull Request to the `dev` branch of the original repository
5. Describe the Issues fixed in your PR description (if applicable)

## Local Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/deepchat.git
   cd deepchat
   ```

2. Install dependencies:

   ```bash
   yarn install
   ```

3. Start the development server:
   ```bash
   yarn dev
   ```

## Project Structure

- `/src` - Main source code
- `/scripts` - Build and development scripts
- `/resources` - Application resources
- `/build` - Build configuration
- `/out` - Build output

## Code Style

- We use ESLint for JavaScript/TypeScript linting
- Prettier for code formatting
- EditorConfig for maintaining consistent coding styles

Please ensure your code follows our style guidelines by running:

```bash
yarn lint
yarn format
```

## Pull Request Process

1. Update the README.md with details of changes to the interface, if applicable.
2. Update documentation in the `/docs` directory if needed.
3. The PR will be merged once you have the sign-off of at least one maintainer.

## Any Questions?

Feel free to open an issue with the tag "question" if you have any questions about contributing.

## License

By contributing, you agree that your contributions will be licensed under the project's license.
