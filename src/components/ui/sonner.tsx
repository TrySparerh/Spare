import { Toaster as Sonner, toast } from "sonner";
import { useTranslation } from "@/i18n";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * The app's toast stack (sonner), styled as a Win98 dialog: grey face and a
 * raised bevel. SystemTray uses it to confirm a copied $SPARE address.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { t } = useTranslation("shell");
  return (
    <Sonner
      position="top-right"
      containerAriaLabel={t("toasts.sonnerLabel")}
      className="toaster group"
      style={
        {
          "--normal-bg": "#c0c0c0",
          "--normal-border": "#0a0a0a",
          "--normal-text": "#000000",
          "--success-bg": "#c0c0c0",
          "--success-text": "#000000",
          "--error-bg": "#c0c0c0",
          "--error-text": "#000000",
          fontFamily: "Inter, system-ui, sans-serif",
        } as React.CSSProperties
      }
      toastOptions={{
        unstyled: false,
        style: {
          background: "#c0c0c0",
          color: "#000",
          border: 0,
          padding: 3,
          borderRadius: 0,
          boxShadow:
            "inset -1px -1px 0 0 #0a0a0a, inset 1px 1px 0 0 #ffffff, inset -2px -2px 0 0 #808080, inset 2px 2px 0 0 #dedede",
          fontFamily: "Inter, system-ui, sans-serif",
        },
        classNames: {
          title: "win98-sonner-title",
          description: "win98-sonner-desc",
          icon: "win98-sonner-icon",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
