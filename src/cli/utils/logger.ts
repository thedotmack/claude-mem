import chalk from 'chalk';

export class Logger {
  constructor(private verbose = false) {}

  success(msg: string): void {
    console.log(chalk.green('✓'), msg);
  }

  error(msg: string, err?: Error): void {
    console.error(chalk.red('✗'), msg);
    if (this.verbose && err?.stack) {
      console.error(chalk.gray(err.stack));
    }
  }

  warning(msg: string): void {
    console.log(chalk.yellow('⚠'), msg);
  }

  info(msg: string): void {
    console.log(chalk.blue('ℹ'), msg);
  }

  title(text: string): void {
    console.log('\n' + chalk.bold.cyan(text));
    console.log(chalk.cyan('═'.repeat(text.length)));
  }

  section(text: string): void {
    console.log('\n' + chalk.bold(text));
  }
}

export const logger = new Logger();
