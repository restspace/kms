import { useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import "./ContextMenu.css";

// Changed to interface since we're just defining the shape of the props
export interface ContextMenuProps {
  position: { x: number; y: number; };
  options: { label: string; onClick: () => void; }[];
  onClose: () => void;
}

// Updated ContextMenu component remains the same
export const ContextMenu = ({ position, options, onClose }: ContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleWindowClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const menuEl = menuRef.current;
      const clickedInsideMenu = !!(menuEl && menuEl.contains(target));
      if (!clickedInsideMenu) {
        onClose();
      }
    };

    // Defer attaching to avoid catching the same event that opened the menu
    const t = setTimeout(() => {
      window.addEventListener('click', handleWindowClick);
      window.addEventListener('contextmenu', handleWindowClick);
    }, 0);

    return () => {
      clearTimeout(t);
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('contextmenu', handleWindowClick);
    };
  }, [onClose]);

  // Stop propagation so clicks on the menu don't immediately close it via the window listener
  const handleMenuClick = (e?: React.MouseEvent) => {
    e?.stopPropagation();
  };

  const menu = (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      data-testid="context-menu"
      style={{ top: position.y, left: position.x }}
      onClick={handleMenuClick}
      onContextMenu={(e) => { e.preventDefault(); handleMenuClick(e as any); }}
    >
      {options.map((option, index) => (
        <div
          key={index}
          className="context-menu-item"
          role="menuitem"
          onClick={option.onClick}
        >
          {option.label}
        </div>
      ))}
    </div>
  );

  return typeof document !== 'undefined' ? ReactDOM.createPortal(menu, document.body) : null;
};