// React Testing Library for the mod's UI tests. The mod package does not depend on it (nor on
// react-dom), so this takes the desktop app's copy; pnpm links both to the same React.
// TODO(lead): add "@testing-library/react" and "react-dom" to this mod's devDependencies and
// import "@testing-library/react" directly.
export * from "../../../../../apps/desktop/node_modules/@testing-library/react";
