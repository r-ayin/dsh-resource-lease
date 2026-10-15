/**
 * client 编译用的环境声明（tsc 单独编译 src/client 时加载）。
 * shorthand ambient module：所有导入均为 any——react 与 slots 在运行时
 * 由 __ModuleLoader__ 的 require 提供，编译期无需真实类型。
 */
declare module 'react';
declare module '@deepseek-ai/dsh-client-ui-slots';
